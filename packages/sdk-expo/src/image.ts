import { DeviceUnavailableError, type LoadProgress } from "@be-natif/core";
import type { ModelFiles } from "@be-natif/react-native/lib";

/** Default image model: SD-Turbo (q8 GGUF, ~2 GB). Stability AI Community License — see README. */
export const DEFAULT_IMAGE_MODEL = {
  id: "sd-turbo-q8",
  url: "https://huggingface.co/Green-Sky/SD-Turbo-GGUF/resolve/main/sd_turbo-f16-q8_0.gguf",
  file: "sd_turbo-f16-q8_0.gguf",
  steps: 4,
  cfgScale: 1.0,
};
export type ImageModel = typeof DEFAULT_IMAGE_MODEL;

export interface NativeImageModuleLike {
  generate(opts: Record<string, unknown>): Promise<{ path: string; width: number; height: number; genMs: number }>;
  unload(): Promise<void>;
  cancel(): void;
  addListener?(event: "onImageProgress", cb: (e: { step: number; steps: number }) => void): { remove(): void };
}

export interface ImageRequest {
  /** What to draw. Short, concrete descriptions work best (subject, style, background). */
  prompt: string;
  negativePrompt?: string;
  /** Default 384×384 (multiples of 64). Bigger is slower and uses more memory. */
  width?: number;
  height?: number;
  /** Sampling steps (default 4 for SD-Turbo; 1 is fastest). */
  steps?: number;
  /** Same seed + prompt → same image. Default: random. */
  seed?: number;
  /** Download (first use, ~2 GB, resumable) and generation progress. */
  onProgress?: (p: LoadProgress) => void;
  signal?: AbortSignal;
}

export interface ImageResult {
  /** file:// URI of the PNG (in the app's cache directory). Use it as <Image source={{ uri }} />. */
  uri: string;
  path: string;
  width: number;
  height: number;
  meta: { modelId: string; runtime: "device"; genMs: number };
}

/** On-device text → image (stable-diffusion.cpp: Metal on iOS, CPU on Android). One call at a time. */
export class NativeImageEngine {
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(
    private native: NativeImageModuleLike | null,
    private files: ModelFiles,
    private outDir: string,
    private model: ImageModel = DEFAULT_IMAGE_MODEL,
  ) {}

  get isLoaded() {
    return this.loaded;
  }

  generate(req: ImageRequest): Promise<ImageResult> {
    const run = this.queue.then(() => this.run(req));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Puts the image model on disk without loading it (resumable). */
  async download(onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<string> {
    const file = `${this.files.dir}/${this.model.file}`;
    if (await this.files.exists(file)) return file;
    await this.files.ensureDir(this.files.dir);
    const part = `${file}.part`;
    if (!this.files.resumes) await this.files.remove(part);
    await this.files.download(this.model.url, part, (f) => onProgress?.({ modelId: this.model.id, progress: Math.min(0.99, f), phase: "download" }), signal);
    await this.files.move(part, file);
    return file;
  }

  private async run(req: ImageRequest): Promise<ImageResult> {
    if (!this.native) throw new DeviceUnavailableError("no_model_for_capability", "image() needs a development build that includes @be-natif/expo (not Expo Go)");
    const prompt = req.prompt?.trim();
    if (!prompt) throw new TypeError("image: prompt is required");
    req.signal?.throwIfAborted();
    const modelPath = toPath(await this.download(req.onProgress, req.signal));
    req.onProgress?.({ modelId: this.model.id, progress: 0, phase: "compile" });
    const sub = this.native.addListener?.("onImageProgress", (e) =>
      req.onProgress?.({ modelId: this.model.id, progress: e.steps ? e.step / e.steps : 0, phase: "compile", text: `step ${e.step}/${e.steps}` }),
    );
    const onAbort = () => this.native?.cancel();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const outPath = `${toPath(this.outDir)}/natif-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      const r = await this.native.generate({
        modelPath,
        prompt,
        negativePrompt: req.negativePrompt ?? "",
        width: req.width ?? 384,
        height: req.height ?? 384,
        steps: req.steps ?? this.model.steps,
        cfgScale: this.model.cfgScale,
        seed: req.seed ?? -1,
        outPath,
      });
      this.loaded = true;
      req.onProgress?.({ modelId: this.model.id, progress: 1, phase: "ready" });
      const path = r.path;
      return { uri: path.startsWith("file://") ? path : `file://${path}`, path, width: r.width, height: r.height, meta: { modelId: this.model.id, runtime: "device", genMs: r.genMs } };
    } finally {
      sub?.remove();
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Frees the image model's memory (the file stays on disk). */
  async unload(): Promise<void> {
    if (!this.native || !this.loaded) return;
    this.loaded = false;
    await this.native.unload();
  }
}

/** Native code needs a filesystem path, expo-file-system gives file:// URIs. */
export function toPath(uriOrPath: string): string {
  return uriOrPath.startsWith("file://") ? decodeURIComponent(uriOrPath.slice("file://".length)) : uriOrPath;
}
