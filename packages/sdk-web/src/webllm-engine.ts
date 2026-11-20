import type { WebWorkerMLCEngine } from "@mlc-ai/web-llm";

// Loaded on demand so apps don't pay ~6 MB of JS until a model is actually needed.
const webllm = () => import("@mlc-ai/web-llm");
import type { DeviceProfile, GenerateRequest, GenerateResult, LoadOptions, LoadProgress, ModelSpec, TextEngine } from "@be-natif/core";

export interface WebLLMEngineOptions {
  /** Override how the worker is created (e.g. bundlers that need an explicit worker import). */
  createWorker?: () => Worker;
}

export class WebLLMEngine implements TextEngine {
  readonly name = "webllm";
  private engine: WebWorkerMLCEngine | undefined;
  private loadedId: string | undefined;
  private loadedCtx: number | undefined;

  constructor(private opts: WebLLMEngineOptions = {}) {}

  resolveModelId(spec: ModelSpec, device: DeviceProfile): string | undefined {
    const w = spec.runtimes.webllm;
    if (!w) return undefined;
    return device.gpu.shaderF16 || !w.f32 ? w.f16 : w.f32;
  }

  async isCached(id: string): Promise<boolean> {
    return (await webllm()).hasModelInCache(id);
  }

  async load(id: string, onProgress?: (p: LoadProgress) => void, opts?: LoadOptions): Promise<void> {
    const ctx = opts?.contextWindow;
    if (this.loadedId === id && this.loadedCtx === ctx) return;
    const chatOpts = ctx ? { context_window_size: ctx } : undefined;
    // Ask the browser not to evict multi-GB weights under storage pressure.
    void navigator.storage?.persist?.().catch(() => {});
    const initProgressCallback = (r: { progress: number; text: string }) =>
      onProgress?.({
        modelId: id,
        progress: r.progress,
        phase: r.progress >= 1 ? "ready" : /fetch/i.test(r.text) ? "download" : "compile",
        text: r.text,
      });
    if (!this.engine) {
      const worker = this.opts.createWorker?.() ?? new Worker(new URL("./llm.worker.js", import.meta.url), { type: "module" });
      this.engine = await (await webllm()).CreateWebWorkerMLCEngine(worker, id, { initProgressCallback }, chatOpts);
    } else {
      this.engine.setInitProgressCallback(initProgressCallback);
      await this.engine.reload(id, chatOpts);
    }
    this.loadedId = id;
    this.loadedCtx = ctx;
  }

  /**
   * Download-only: stores config, tokenizer, weight shards and the model library in the same Cache
   * Storage buckets and keys WebLLM reads on `load`, so `load` then only compiles. Shards already
   * stored are skipped, so an interrupted download resumes shard by shard (~30 MB each).
   */
  async download(id: string, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<void> {
    if (typeof caches === "undefined") return;
    void navigator.storage?.persist?.().catch(() => {});
    const { prebuiltAppConfig } = await webllm();
    const record = prebuiltAppConfig.model_list.find((m) => m.model_id === id);
    if (!record) throw new Error(`WebLLMEngine: unknown model ${id}`);
    if ((record as any).model_manifest) return; // packaged models: leave it to load()
    let base = record.model;
    if (!/\/resolve\/[^/]+\/?$/.test(base)) base = base.replace(/\/?$/, "/") + "resolve/main/";
    base = base.replace(/\/?$/, "/");
    const [configCache, modelCache, wasmCache] = (await Promise.all(["webllm/config", "webllm/model", "webllm/wasm"].map((n) => caches.open(n)))) as [Cache, Cache, Cache];
    const ensure = async (cache: Cache, url: string) => {
      signal?.throwIfAborted();
      if (await cache.match(url)) return false;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
      await cache.put(url, res);
      return true;
    };
    const report = (progress: number, text: string) => onProgress?.({ modelId: id, progress, phase: progress >= 1 ? "ready" : "download", text });

    const configUrl = new URL("mlc-chat-config.json", base).href;
    await ensure(configCache, configUrl);
    const config = await (await configCache.match(configUrl))!.json();
    const manifestUrl = new URL("tensor-cache.json", base).href;
    await ensure(modelCache, manifestUrl);
    const manifest = await (await modelCache.match(manifestUrl))!.json();
    const tok = (config.tokenizer_files as string[]).includes("tokenizer.json") ? "tokenizer.json" : "tokenizer.model";
    await ensure(modelCache, new URL(tok, base).href);
    if (record.model_lib && !record.model_lib.includes("localhost")) await ensure(wasmCache, record.model_lib);

    const shards = manifest.records as { dataPath: string; nbytes: number }[];
    const total = shards.reduce((a, r) => a + r.nbytes, 0);
    let done = 0;
    for (const r of shards) {
      await ensure(modelCache, new URL(r.dataPath, base).href);
      done += r.nbytes;
      report(done / total, `${Math.round(done / 1e6)} / ${Math.round(total / 1e6)} MB`);
    }
    report(1, "downloaded");
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      return await this.generateRaw(req);
    } catch (e) {
      // WebLLM sometimes throws plain strings across the worker boundary; always surface an Error.
      if (e instanceof Error) throw e;
      const msg = String(e);
      const err = new Error(msg);
      err.name = /^(\w+Error):/.exec(msg)?.[1] ?? "Error";
      throw err;
    }
  }

  private async generateRaw(req: GenerateRequest): Promise<GenerateResult> {
    if (!this.engine || !this.loadedId) throw new Error("WebLLMEngine: no model loaded");
    const t0 = performance.now();
    let ttft = -1;
    let text = "";
    let usage: any;
    const stream = await this.engine.chat.completions.create({
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      ...(req.jsonSchema ? { response_format: { type: "json_object", schema: JSON.stringify(req.jsonSchema) } } : {}),
      ...(req.disableThinking ? { extra_body: { enable_thinking: false } } : {}),
    } as any);
    const onAbort = () => this.engine?.interruptGenerate();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const chunk of stream as unknown as AsyncIterable<any>) {
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta && ttft < 0) ttft = performance.now() - t0;
        text += delta;
        if (delta) req.onToken?.(delta);
        if (chunk.usage) usage = chunk.usage;
      }
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
    if (req.signal?.aborted) throw req.signal.reason ?? new DOMException("Aborted", "AbortError");
    const totalMs = performance.now() - t0;
    const completionTokens: number = usage?.completion_tokens ?? 0;
    return {
      text,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens,
      ttftMs: Math.round(ttft),
      totalMs: Math.round(totalMs),
      decodeTokPerSec: usage?.extra?.decode_tokens_per_s ?? (completionTokens / Math.max(totalMs - ttft, 1)) * 1000,
    };
  }

  async unload(): Promise<void> {
    await this.engine?.unload();
    this.loadedId = undefined;
  }
}
