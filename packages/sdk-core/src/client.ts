import { z } from "zod";
import { MODEL_CATALOG } from "./catalog";
import { cloudExtract, DEFAULT_PRICE_REFERENCE, estimateSavingsUsd, type PriceReference } from "./cloud";
import { deviceKey as computeDeviceKey } from "./device";
import { DeviceUnavailableError, SchemaValidationError } from "./errors";
import { type Grounding, groundedMessage, Knowledge, type KnowledgeChunk, type KnowledgeOptions, toSources } from "./knowledge";
import { BENCHMARK_MESSAGES, buildExtractMessages } from "./prompt";
import { extractJson, parseModelOutput, repairMessage, schemaHash, toJsonSchema } from "./schema";
import { decideRuntime, selectModel, type DeviceRecommendation } from "./selection";
import { type LocalTask, TaskStore } from "./tasks";
import { TelemetryQueue, type TelemetryTransport } from "./telemetry";
import type {
  BenchmarkResult,
  Capability,
  ChatRequest,
  ChatResult,
  Consent,
  DeviceProfile,
  ExtractMeta,
  ExtractRequest,
  ExtractResult,
  FallbackReason,
  KeyValueStore,
  LoadProgress,
  ModelSpec,
  RuntimeMode,
  TaskConfig,
  TextEngine,
} from "./types";

const DEFAULT_MAX_HISTORY = 20;

/**
 * Cache-friendly trimming: instead of sliding one message per turn (which changes the prefix and
 * invalidates the engine's KV cache every time), drop a block down to half the limit, so the
 * same prefix is reused for the next max/2 turns. Always starts on a user turn.
 */
export const CLASSIFY_TASK = "benatif.classify";
/** Tasks the SDK ships with; an app task with the same slug overrides them. */
export const BUILTIN_TASKS: Record<string, LocalTask> = {
  [CLASSIFY_TASK]: {
    systemPrompt: "You are a precise text classifier. Read the text and choose the single label from the given list that fits it best. Follow the instructions if any. Answer with JSON only.",
    temperature: 0,
    maxTokens: 40,
  },
};

export interface ClassifyRequest<L extends string> {
  text: string;
  labels: readonly L[];
  /** Optional guidance, e.g. "classify by urgency". */
  instructions?: string;
  signal?: AbortSignal;
}
export interface ClassifyResult<L extends string> {
  label: L;
  meta: ExtractMeta;
}

export function trimHistory<M extends { role: string }>(history: M[], max: number): { kept: M[]; dropped: number } {
  if (max <= 0) return { kept: [], dropped: history.length };
  if (history.length <= max) return { kept: history, dropped: 0 };
  const target = Math.max(1, Math.floor(max / 2));
  const block = Math.floor(history.length / target) * target - target;
  let start = Math.max(history.length - max, block);
  while (start < history.length && history[start]!.role !== "user") start++;
  return { kept: history.slice(start), dropped: start };
}

export interface ClientOptions {
  /** Public project key (pk_...). Optional when every task is local and the cloud is not used. */
  apiKey?: string;
  baseUrl?: string;
  capabilities?: Capability[];
  /** "eager" downloads and benchmarks the models at init; "lazy" waits for the first call. */
  preload?: "lazy" | "eager";
  runtime?: RuntimeMode;
  consent?: Partial<Consent>;
  /** Tasks defined in code instead of the dashboard (useful offline or before having a backend). */
  tasks?: Record<string, LocalTask>;
  onDownloadProgress?: (p: LoadProgress) => void;
  /** Your own knowledge for `chat`: inline docs and/or your retrieval. benatif never stores it. */
  knowledge?: KnowledgeOptions;
  /** How strictly `chat` sticks to `knowledge` (default "prefer" when knowledge is set). */
  grounding?: Grounding;
  catalog?: readonly ModelSpec[];
  priceReference?: PriceReference;
  /** Device inference slower than this is abandoned (and goes to the cloud if allowed). */
  timeoutMs?: number;
  /**
   * Max memory (MB) a model may take. Browsers can't see free RAM, only (roughly) the total, so
   * set this if you know better. Default: 60% of available RAM on native, 50% of total on web.
   */
  memoryBudgetMB?: number;
  /**
   * Tokens of context to allocate for the text model (prompt + output). Default: the engine's
   * (4096 on native). Raise it for long prompts or long outputs such as generated code; it uses
   * more memory.
   */
  contextWindow?: number;
  /** Free the model from RAM/GPU after this long without use (ms). Default 2 min; 0 = never. */
  idleUnloadMs?: number;
}

/** What each platform package provides. */
export interface PlatformAdapter {
  sdkVersion: string;
  detectDevice(): Promise<DeviceProfile>;
  createTextEngine(): TextEngine;
  storage: KeyValueStore;
  fetch: typeof fetch;
  telemetryTransport?: (url: string, apiKey: string) => TelemetryTransport;
}

export interface CapabilityReport {
  device: DeviceProfile;
  deviceKey: string;
  text: { modelId: string; tier: "high" | "low"; cached: boolean } | { unavailable: FallbackReason };
}

const BENCHMARK_TOKENS = 64;

export class NatifClient {
  private consent: Consent;
  private mode: RuntimeMode;
  private catalog: readonly ModelSpec[];
  private tasks: TaskStore;
  private telemetry: TelemetryQueue | undefined;
  private devicePromise: Promise<{ profile: DeviceProfile; key: string }> | undefined;
  private engine: TextEngine | undefined;
  private loaded: { spec: ModelSpec; engineModelId: string; loadMs: number } | undefined;
  private knowledge: Knowledge | undefined;
  private loading: Promise<{ spec: ModelSpec; engineModelId: string } | { failure: FallbackReason }> | undefined;
  private warnedSchemas = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = 0;

  constructor(
    private opts: ClientOptions,
    private platform: PlatformAdapter,
  ) {
    this.consent = { cloudFallback: false, telemetry: false, ...opts.consent };
    this.mode = opts.runtime ?? "auto";
    this.catalog = opts.catalog ?? MODEL_CATALOG;
    if (opts.knowledge) this.knowledge = new Knowledge(opts.knowledge);
    this.tasks = new TaskStore({
      local: { ...BUILTIN_TASKS, ...opts.tasks },
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      storage: platform.storage,
      fetch: platform.fetch,
      deviceKey: async () => (await this.device()).key,
    });
    if (opts.baseUrl && opts.apiKey && platform.telemetryTransport) {
      this.telemetry = new TelemetryQueue(platform.telemetryTransport(`${opts.baseUrl}/v1/telemetry`, opts.apiKey), {
        enabled: () => this.consent.telemetry,
      });
    }
    if (opts.preload === "eager" && (opts.capabilities ?? ["text"]).includes("text") && this.mode !== "cloud-only") {
      void this.ensureTextModel(8).catch(() => {});
    }
  }

  /** Update consent after the user answers (e.g. from a settings screen). */
  setConsent(consent: Partial<Consent>): void {
    this.consent = { ...this.consent, ...consent };
  }

  /**
   * Conversation on the device, streamed through `onToken`. The app owns the history and passes
   * it on every turn; the result returns the updated history.
   * On-device only for now: throws DeviceUnavailableError when the device can't run a model.
   */
  async chat<T = unknown>(req: ChatRequest): Promise<ChatResult<T>> {
    const message = req.message?.trim();
    if (!message) throw new TypeError("chat: message is required");
    if (this.mode === "cloud-only") throw new DeviceUnavailableError("forced_cloud", "chat runs on the device only");
    const history = (req.history ?? []).filter((m) => m.role !== "system");
    const { kept, dropped } = trimHistory(history, req.maxHistoryMessages ?? DEFAULT_MAX_HISTORY);
    const t0 = now();
    this.inFlight++;
    clearTimeout(this.idleTimer);
    try {
      const ready = await this.ensureTextModel(4);
      if ("failure" in ready) throw new DeviceUnavailableError(ready.failure);
      const user = { role: "user" as const, content: message };
      // Knowledge goes into this turn only; the returned history keeps the plain message.
      const grounding = req.grounding ?? this.opts.grounding ?? (this.knowledge ? "prefer" : "off");
      let chunks: KnowledgeChunk[] | undefined;
      let sent = user;
      if (this.knowledge && grounding !== "off") {
        chunks = await this.knowledge.find(message, req.signal);
        sent = { role: "user", content: groundedMessage(message, chunks, grounding) };
      }
      const messages = [...(req.system ? [{ role: "system" as const, content: req.system }] : []), ...kept, sent];
      let filtering = false; // hide <think>…</think> if a model emits it anyway
      const zodSchema = req.schema instanceof z.ZodType ? req.schema : undefined;
      const jsonSchema = zodSchema ? toJsonSchema(zodSchema) : (req.schema as Record<string, unknown> | undefined);
      let r = await this.textEngine().generate({
        messages,
        jsonSchema,
        maxTokens: req.maxTokens ?? 512,
        temperature: req.temperature ?? (jsonSchema ? 0.2 : 0.7),
        disableThinking: jsonSchema ? true : ready.spec.disableThinking,
        signal: req.signal,
        onToken: req.onToken
          ? (d) => {
              if (d.includes("<think>")) filtering = true;
              if (filtering) {
                if (d.includes("</think>")) filtering = false;
                return;
              }
              req.onToken!(d);
            }
          : undefined,
      });
      let data: T | undefined;
      if (jsonSchema) {
        const parse = (raw: string): { ok: true; data: T } | { ok: false; error: string; issues?: unknown } => {
          if (zodSchema) return parseModelOutput(zodSchema, raw) as { ok: true; data: T } | { ok: false; error: string };
          try { return { ok: true, data: extractJson(raw) as T }; } catch (e) { return { ok: false, error: (e as Error).message }; }
        };
        let out = parse(r.text);
        if (!out.ok) {
          const first = r;
          r = await this.textEngine().generate({
            messages: [...messages, { role: "assistant", content: r.text }, { role: "user", content: repairMessage(out.error) }],
            jsonSchema,
            maxTokens: req.maxTokens ?? 512,
            temperature: 0,
            disableThinking: true,
            signal: req.signal,
          });
          r = { ...r, promptTokens: r.promptTokens + first.promptTokens, completionTokens: r.completionTokens + first.completionTokens };
          out = parse(r.text);
          if (!out.ok) throw new SchemaValidationError(out.issues ?? out.error, r.text);
        }
        data = out.data;
      }
      const text = r.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      return {
        text,
        ...(jsonSchema ? { data } : {}),
        history: [...history, user, { role: "assistant", content: text }],
        ...(chunks ? { sources: toSources(chunks, text) } : {}),
        meta: {
          modelId: ready.spec.id,
          runtime: "device",
          latencyMs: Math.round(now() - t0),
          ttftMs: r.ttftMs,
          tokensIn: r.promptTokens,
          tokensOut: r.completionTokens,
          decodeTokPerSec: r.decodeTokPerSec,
          estimatedSavingsUsd: estimateSavingsUsd(r.promptTokens, r.completionTokens, this.opts.priceReference ?? DEFAULT_PRICE_REFERENCE),
          cachedTokens: r.cachedTokens,
          droppedMessages: dropped,
        },
      };
    } finally {
      this.inFlight--;
      this.scheduleIdleUnload();
    }
  }

  /**
   * Zero-shot classification on the device: picks exactly one of `labels` for `text`.
   * Built on extract (same model choice, validation, telemetry and fallback rules).
   */
  async classify<L extends string>(req: ClassifyRequest<L>): Promise<ClassifyResult<L>> {
    const labels = [...new Set(req.labels.map((l) => l.trim()).filter(Boolean))];
    if (labels.length < 2) throw new TypeError("classify: give at least 2 labels");
    if (!req.text?.trim()) throw new TypeError("classify: text is required");
    const schema = z.object({ label: z.enum(labels as [string, ...string[]]) });
    const input = `${req.instructions ? `Instructions: ${req.instructions}\n` : ""}Labels: ${labels.join(" | ")}\nText: ${req.text.trim()}`;
    const r = await this.extractWithMeta({ task: CLASSIFY_TASK, schema, input: { text: input }, signal: req.signal });
    return { label: r.data.label as L, meta: r.meta };
  }

  async extract<S extends z.ZodType>(req: ExtractRequest<S>): Promise<z.infer<S>> {
    return (await this.extractWithMeta(req)).data;
  }

  async extractWithMeta<S extends z.ZodType>(req: ExtractRequest<S>): Promise<ExtractResult<z.infer<S>>> {
    const text = req.input.text?.trim();
    if (!text) throw new TypeError("extract: input.text is required (audio and image inputs come in later versions)");
    const t0 = now();
    const { task, recommendation } = await this.tasks.get(req.task);
    const jsonSchema = toJsonSchema(req.schema);
    void this.warnOnSchemaDrift(task, jsonSchema);

    let deviceFailure: FallbackReason | null = null;
    let failureDetail: { issues?: unknown; raw?: string } = {};

    if (this.mode !== "cloud-only") {
      this.inFlight++;
      clearTimeout(this.idleTimer);
      try {
      const ready = await this.ensureTextModel(task.minDeviceTokPerSec, recommendation, task.recommendedModel);
      if ("failure" in ready) {
        deviceFailure = ready.failure;
      } else {
        const r = await this.runOnDevice(req.schema, task, jsonSchema, text, req.signal);
        if (r.ok) {
          const meta: ExtractMeta = {
            modelId: ready.spec.id,
            runtime: "device",
            taskVersion: task.version,
            latencyMs: Math.round(now() - t0),
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
            estimatedSavingsUsd: estimateSavingsUsd(r.tokensIn, r.tokensOut, this.opts.priceReference ?? DEFAULT_PRICE_REFERENCE),
            repaired: r.repaired || undefined,
          };
          await this.record(task, meta, "ok", r.decodeTokPerSec);
          return { data: r.data, meta };
        }
        deviceFailure = r.reason;
        failureDetail = { issues: r.issues, raw: r.raw };
      }
      } finally {
        this.inFlight--;
        this.scheduleIdleUnload();
      }
    }

    const decision = decideRuntime({
      mode: this.mode,
      consent: this.consent,
      taskDeviceOnly: task.deviceOnly ?? false,
      deviceFailure,
    });

    if (decision.runtime === "none") {
      const meta = this.failureMeta(task, t0, decision.reason);
      await this.record(task, meta, decision.reason === "schema_failed_after_repair" ? "schema_error" : "unavailable");
      if (decision.reason === "schema_failed_after_repair") throw new SchemaValidationError(failureDetail.issues, failureDetail.raw ?? "");
      throw new DeviceUnavailableError(decision.reason, this.consent.cloudFallback ? undefined : "cloud fallback not consented");
    }
    if (decision.runtime === "device") throw new Error("unreachable");

    if (!this.opts.baseUrl || !this.opts.apiKey) {
      throw new DeviceUnavailableError(decision.reason, "cloud fallback needs apiKey and baseUrl");
    }
    const cloud = await cloudExtract({
      fetch: this.platform.fetch,
      baseUrl: this.opts.baseUrl,
      apiKey: this.opts.apiKey,
      task: task.slug,
      taskVersion: task.version,
      text,
      jsonSchema,
      signal: req.signal,
    });
    const parsed = req.schema.safeParse(cloud.data);
    if (!parsed.success) throw new SchemaValidationError(parsed.error.issues, JSON.stringify(cloud.data));
    const meta: ExtractMeta = {
      modelId: cloud.model,
      runtime: "cloud",
      taskVersion: task.version,
      latencyMs: Math.round(now() - t0),
      tokensIn: cloud.usage.inputTokens,
      tokensOut: cloud.usage.outputTokens,
      estimatedSavingsUsd: 0,
      fallbackReason: decision.reason,
    };
    await this.record(task, meta, "ok");
    return { data: parsed.data as z.infer<S>, meta };
  }

  /** Download, load and benchmark ahead of time (e.g. during onboarding). */
  async prepare(opts: { task?: string } = {}): Promise<CapabilityReport> {
    let min = 8;
    let rec: DeviceRecommendation | undefined;
    let preferred: string | undefined;
    if (opts.task) {
      const b = await this.tasks.get(opts.task);
      min = b.task.minDeviceTokPerSec;
      rec = b.recommendation;
      preferred = b.task.recommendedModel;
    }
    await this.ensureTextModel(min, rec, preferred);
    return this.capabilities();
  }

  /**
   * Download the text model this device would use, without loading it into GPU/RAM. Meant for a
   * landing page or onboarding: when the user reaches the feature, only compilation is left.
   * Resumes an interrupted download. Resolves with what was chosen, or why nothing was downloaded.
   */
  async download(opts: { signal?: AbortSignal; onProgress?: (p: LoadProgress) => void } = {}): Promise<
    { modelId: string; engineModelId: string; downloadBytes: number } | { unavailable: FallbackReason | "unsupported_engine" }
  > {
    if (this.mode === "cloud-only") return { unavailable: "forced_cloud" };
    const sel = await this.select(8);
    if (!sel.ok) return { unavailable: sel.reason };
    const engine = this.textEngine();
    if (!engine.download) return { unavailable: "unsupported_engine" };
    await engine.download(sel.engineModelId, opts.onProgress ?? this.opts.onDownloadProgress, opts.signal);
    return { modelId: sel.spec.id, engineModelId: sel.engineModelId, downloadBytes: sel.spec.downloadBytes };
  }

  /** What this device can do, without downloading anything. */
  async capabilities(): Promise<CapabilityReport> {
    const { profile, key } = await this.device();
    if (this.loaded) {
      return { device: profile, deviceKey: key, text: { modelId: this.loaded.spec.id, tier: this.loaded.spec.tier, cached: true } };
    }
    const sel = await this.select(8);
    if (!sel.ok) return { device: profile, deviceKey: key, text: { unavailable: sel.reason } };
    const cached = await this.textEngine().isCached(sel.engineModelId);
    return { device: profile, deviceKey: key, text: { modelId: sel.spec.id, tier: sel.spec.tier, cached } };
  }

  private scheduleIdleUnload() {
    const ms = this.opts.idleUnloadMs ?? 120_000;
    if (!ms || this.inFlight > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.inFlight === 0) void this.unload();
    }, ms);
  }

  /** Frees GPU/RAM (call when the app goes to background on mobile). The model stays on disk. */
  async unload(): Promise<void> {
    clearTimeout(this.idleTimer);
    await this.engine?.unload();
    this.loaded = undefined;
    this.loading = undefined;
  }

  async clearCache(): Promise<void> {
    await this.unload();
    await this.platform.storage.clear();
  }

  async flushTelemetry(): Promise<void> {
    await this.telemetry?.flush();
  }

  // ---------------------------------------------------------------------------------------

  private device() {
    this.devicePromise ??= this.platform.detectDevice().then(async (profile) => ({ profile, key: await computeDeviceKey(profile) }));
    return this.devicePromise;
  }

  private textEngine(): TextEngine {
    this.engine ??= this.platform.createTextEngine();
    return this.engine;
  }

  private benchKey(deviceKey: string, modelId: string) {
    return `bench:${deviceKey}:${modelId}:${this.platform.sdkVersion}`;
  }

  private async select(minTokPerSec: number, recommendation?: DeviceRecommendation, preferred?: string) {
    const { profile, key } = await this.device();
    const engine = this.textEngine();
    const benchmarks: Record<string, BenchmarkResult> = {};
    const cached = new Set<string>();
    for (const spec of this.catalog) {
      const b = await this.platform.storage.get<BenchmarkResult>(this.benchKey(key, spec.id));
      if (b) benchmarks[spec.id] = b;
      const id = engine.resolveModelId(spec, profile);
      if (id && (await engine.isCached(id).catch(() => false))) cached.add(id);
    }
    return selectModel({
      device: profile,
      capability: "text",
      catalog: this.catalog,
      engine,
      minDeviceTokPerSec: minTokPerSec,
      cached,
      benchmarks,
      recommendation,
      preferredModel: preferred,
      memoryBudgetMB: this.opts.memoryBudgetMB,
    });
  }

  /**
   * Single-flight: picks a model, loads it, benchmarks it once per device+model+SDK version,
   * and steps down to the next candidate if the benchmark is too slow.
   */
  private ensureTextModel(minTokPerSec: number, recommendation?: DeviceRecommendation, preferred?: string) {
    if (this.loaded) return Promise.resolve(this.loaded);
    this.loading ??= (async () => {
      const { key } = await this.device();
      const engine = this.textEngine();
      for (let attempt = 0; attempt < this.catalog.length; attempt++) {
        const sel = await this.select(minTokPerSec, recommendation, preferred);
        if (!sel.ok) return { failure: sel.reason };
        const t0 = now();
        try {
          await engine.load(sel.engineModelId, this.opts.onDownloadProgress, this.opts.contextWindow ? { contextWindow: this.opts.contextWindow } : undefined);
        } catch {
          // Mark it as unusable on this device so selection skips it, then try the next one.
          await this.platform.storage.set<BenchmarkResult>(this.benchKey(key, sel.spec.id), {
            modelId: sel.spec.id,
            decodeTokPerSec: 0,
            ttftMs: -1,
            at: Date.now(),
          });
          continue;
        }
        const loadMs = now() - t0;
        const bk = this.benchKey(key, sel.spec.id);
        let bench = await this.platform.storage.get<BenchmarkResult>(bk);
        if (!bench) {
          const r = await engine.generate({ messages: BENCHMARK_MESSAGES, maxTokens: BENCHMARK_TOKENS, temperature: 0, disableThinking: true });
          bench = { modelId: sel.spec.id, decodeTokPerSec: r.decodeTokPerSec, ttftMs: r.ttftMs, at: Date.now() };
          await this.platform.storage.set(bk, bench);
        }
        if (bench.decodeTokPerSec < minTokPerSec) {
          await engine.unload();
          continue;
        }
        this.loaded = { spec: sel.spec, engineModelId: sel.engineModelId, loadMs };
        return this.loaded;
      }
      return { failure: "benchmark_slow" as const };
    })().then((r) => {
      if ("failure" in r) this.loading = undefined; // allow retry later (e.g. after freeing storage)
      return r;
    });
    return this.loading;
  }

  private async runOnDevice<S extends z.ZodType>(
    schema: S,
    task: TaskConfig,
    jsonSchema: Record<string, unknown>,
    text: string,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; data: z.infer<S>; tokensIn: number; tokensOut: number; decodeTokPerSec: number; repaired: boolean }
    | { ok: false; reason: FallbackReason; issues?: unknown; raw?: string }
  > {
    const engine = this.textEngine();
    const spec = this.loaded!.spec;
    const messages = buildExtractMessages(task, jsonSchema, text);
    const gen = (msgs: typeof messages) =>
      withTimeout(
        engine.generate({
          messages: msgs,
          jsonSchema,
          maxTokens: task.maxTokens,
          temperature: task.temperature,
          disableThinking: spec.disableThinking,
          signal,
        }),
        this.opts.timeoutMs ?? 60_000,
      );
    try {
      const first = await gen(messages);
      const p1 = parseModelOutput(schema, first.text);
      if (p1.ok) {
        return { ok: true, data: p1.data, tokensIn: first.promptTokens, tokensOut: first.completionTokens, decodeTokPerSec: first.decodeTokPerSec, repaired: false };
      }
      const second = await gen([
        ...messages,
        { role: "assistant", content: first.text },
        { role: "user", content: repairMessage(p1.error) },
      ]);
      const p2 = parseModelOutput(schema, second.text);
      if (p2.ok) {
        return {
          ok: true,
          data: p2.data,
          tokensIn: first.promptTokens + second.promptTokens,
          tokensOut: first.completionTokens + second.completionTokens,
          decodeTokPerSec: second.decodeTokPerSec,
          repaired: true,
        };
      }
      return { ok: false, reason: "schema_failed_after_repair", issues: p2.issues, raw: second.text };
    } catch (e) {
      if (signal?.aborted) throw e;
      return { ok: false, reason: e instanceof TimeoutError ? "timeout" : "engine_error" };
    }
  }

  private failureMeta(task: TaskConfig, t0: number, reason: FallbackReason): ExtractMeta {
    return {
      modelId: this.loaded?.spec.id ?? "none",
      runtime: "device",
      taskVersion: task.version,
      latencyMs: Math.round(now() - t0),
      tokensIn: 0,
      tokensOut: 0,
      estimatedSavingsUsd: 0,
      fallbackReason: reason,
    };
  }

  private async record(task: TaskConfig, meta: ExtractMeta, outcome: string, decodeTokPerSec?: number) {
    if (!this.telemetry) return;
    const { profile, key } = await this.device();
    this.telemetry.record({
      ts: Date.now(),
      task: task.slug,
      taskVersion: task.version,
      runtime: outcome === "unavailable" || outcome === "schema_error" ? "none" : meta.runtime,
      modelId: meta.modelId,
      deviceKey: key,
      platform: profile.platform,
      latencyMs: meta.latencyMs,
      loadMs: this.loaded ? Math.round(this.loaded.loadMs) : undefined,
      decodeTokPerSec,
      tokensIn: meta.tokensIn,
      tokensOut: meta.tokensOut,
      outcome,
      fallbackReason: meta.fallbackReason,
      repaired: meta.repaired,
      sdkVersion: this.platform.sdkVersion,
    });
  }

  private async warnOnSchemaDrift(task: TaskConfig, jsonSchema: Record<string, unknown>) {
    if (!task.jsonSchema || this.warnedSchemas.has(task.slug)) return;
    const [a, b] = await Promise.all([schemaHash(jsonSchema), schemaHash(task.jsonSchema)]);
    if (a !== b) {
      this.warnedSchemas.add(task.slug);
      console.warn(`[benatif] The schema in code for task "${task.slug}" differs from the published one. The code schema is used.`);
    }
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function createCoreClient(opts: ClientOptions, platform: PlatformAdapter): NatifClient {
  return new NatifClient(opts, platform);
}
