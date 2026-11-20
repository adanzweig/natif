import type { DeviceProfile, GenerateRequest, GenerateResult, LoadProgress, ModelSpec, TextEngine } from "@be-natif/core";
import type { ModelFiles } from "./files";

/** The slice of llama.rn this engine uses (injected so tests don't need a phone). */
export interface LlamaModule {
  initLlama(params: Record<string, unknown>, onProgress?: (progress: number) => void): Promise<LlamaContextLike>;
}
export interface LlamaContextLike {
  completion(
    params: Record<string, unknown>,
    callback?: (data: { token: string }) => void,
  ): Promise<{
    text: string;
    content?: string;
    tokens_predicted: number;
    tokens_evaluated: number;
    tokens_cached?: number;
    interrupted?: boolean;
    timings: { predicted_per_second: number; prompt_n: number; cache_n?: number };
  }>;
  stopCompletion(): Promise<void>;
  release(): Promise<void>;
}

export interface LlamaRNEngineOptions {
  /** Context window in tokens. Larger = longer chats, more memory. Default 4096. */
  nCtx?: number;
  /** Layers offloaded to the GPU (Metal on iOS). Default 99 = all; 0 forces CPU. */
  nGpuLayers?: number;
}

/** Runs GGUF models with llama.cpp through llama.rn. Downloads each model once into the app sandbox. */
export class LlamaRNEngine implements TextEngine {
  readonly name = "llama.rn";
  private ctx: LlamaContextLike | undefined;
  private loadedId: string | undefined;
  private urls = new Map<string, string>();

  constructor(
    private llama: LlamaModule,
    private files: ModelFiles,
    private opts: LlamaRNEngineOptions = {},
  ) {}

  resolveModelId(spec: ModelSpec, _device: DeviceProfile): string | undefined {
    const url = spec.runtimes.gguf?.url;
    if (!url) return undefined;
    const id = url.split("/").pop()!.replace(/\.gguf$/i, "");
    this.urls.set(id, url);
    return id;
  }

  private path(id: string) {
    return `${this.files.dir}/${id}.gguf`;
  }

  async isCached(id: string): Promise<boolean> {
    return this.files.exists(this.path(id));
  }

  /** Model file on disk, downloading it if needed. Only complete files count as cached. */
  private async ensureFile(id: string, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<string> {
    const file = this.path(id);
    if (await this.files.exists(file)) return file;
    const url = this.urls.get(id);
    if (!url) throw new Error(`LlamaRNEngine: unknown model ${id}`);
    await this.files.ensureDir(this.files.dir);
    const part = `${file}.part`;
    if (!this.files.resumes) await this.files.remove(part);
    await this.files.download(url, part, (f) => onProgress?.({ modelId: id, progress: f, phase: "download" }), signal);
    await this.files.move(part, file);
    return file;
  }

  /** Download only (e.g. on Wi-Fi during onboarding); `load` then just maps the file. */
  async download(id: string, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<void> {
    await this.ensureFile(id, onProgress, signal);
    onProgress?.({ modelId: id, progress: 1, phase: "ready", text: "downloaded" });
  }

  async load(id: string, onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.loadedId === id && this.ctx) return;
    await this.unload();
    const file = await this.ensureFile(id, onProgress);
    this.ctx = await this.llama.initLlama(
      { model: file, n_ctx: this.opts.nCtx ?? 4096, n_gpu_layers: this.opts.nGpuLayers ?? 99, use_mlock: false, use_progress_callback: true },
      (p) => onProgress?.({ modelId: id, progress: p > 1 ? p / 100 : p, phase: "compile" }),
    );
    this.loadedId = id;
    onProgress?.({ modelId: id, progress: 1, phase: "ready" });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("LlamaRNEngine: no model loaded");
    const t0 = Date.now();
    let ttft = -1;
    const onAbort = () => void ctx.stopCompletion();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await ctx.completion(
        {
          messages: req.messages,
          n_predict: req.maxTokens,
          temperature: req.temperature,
          ...(req.jsonSchema ? { response_format: { type: "json_schema", json_schema: { strict: true, schema: req.jsonSchema } } } : {}),
          ...(req.disableThinking ? { enable_thinking: false } : {}),
        },
        (d) => {
          if (!d.token) return;
          if (ttft < 0) ttft = Date.now() - t0;
          req.onToken?.(d.token);
        },
      );
      if (req.signal?.aborted) throw req.signal.reason ?? new Error("Aborted");
      return {
        text: r.content ?? r.text,
        promptTokens: r.tokens_evaluated,
        completionTokens: r.tokens_predicted,
        ttftMs: Math.max(ttft, 0),
        totalMs: Date.now() - t0,
        decodeTokPerSec: r.timings.predicted_per_second,
        cachedTokens: r.tokens_cached ?? r.timings.cache_n,
      };
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  async unload(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = undefined;
    this.loadedId = undefined;
    await ctx?.release();
  }

  /** Deletes a downloaded model file (frees storage). */
  async deleteModel(id: string): Promise<void> {
    if (this.loadedId === id) await this.unload();
    await this.files.remove(this.path(id));
  }
}
