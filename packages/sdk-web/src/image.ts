import { DeviceUnavailableError, type LoadProgress } from "@be-natif/core";

export const IMAGE_MODEL_ID = "onnx-community/Janus-Pro-1B-ONNX";

export interface ImageRequest {
  /** What to draw. Short, concrete descriptions work best (subject, style, background). */
  prompt: string;
  /** Download / load progress of the image model (first use downloads ~1.4 GB, then cached). */
  onProgress?: (p: LoadProgress) => void;
  signal?: AbortSignal;
}

export interface ImageResult {
  /** PNG image. Use URL.createObjectURL(blob) to show it, or createImageBitmap(blob) to draw it. */
  blob: Blob;
  width: number;
  height: number;
  meta: { modelId: string; runtime: "device"; loadMs?: number; genMs: number };
}

type Out =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; loadMs: number }
  | { type: "image"; png: Blob; genMs: number; width: number; height: number }
  | { type: "error"; message: string };

/** Text → image on the device (WebGPU). One request at a time; calls queue up. */
export class ImageEngine {
  private worker: Worker | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private active = 0;

  constructor(private createWorker?: () => Worker) {}

  generate(req: ImageRequest): Promise<ImageResult> {
    this.active++;
    const run = this.queue.then(() => this.run(req)).finally(() => this.active--);
    this.queue = run.catch(() => {});
    return run;
  }

  private async run(req: ImageRequest): Promise<ImageResult> {
    const prompt = req.prompt?.trim();
    if (!prompt) throw new TypeError("image: prompt is required");
    const gpu = (navigator as any).gpu;
    if (!gpu || !(await gpu.requestAdapter().catch(() => null))) throw new DeviceUnavailableError("no_webgpu", "image generation needs WebGPU");
    req.signal?.throwIfAborted();
    const w = (this.worker ??= this.createWorker?.() ?? new Worker(new URL("./image.worker.js", import.meta.url), { type: "module" }));
    let loadMs: number | undefined;
    return new Promise<ImageResult>((resolve, reject) => {
      const onAbort = () => { this.unload(true); reject(req.signal!.reason ?? new DOMException("Aborted", "AbortError")); };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => req.signal?.removeEventListener("abort", onAbort);
      w.onmessage = (ev: MessageEvent<Out>) => {
        const m = ev.data;
        if (m.type === "progress") req.onProgress?.({ modelId: IMAGE_MODEL_ID, progress: m.total ? Math.min(0.99, m.loaded / m.total) : 0, phase: "download" });
        else if (m.type === "ready") { loadMs = Math.round(m.loadMs); req.onProgress?.({ modelId: IMAGE_MODEL_ID, progress: 1, phase: "ready" }); }
        else if (m.type === "image") { done(); resolve({ blob: m.png, width: m.width, height: m.height, meta: { modelId: IMAGE_MODEL_ID, runtime: "device", loadMs, genMs: Math.round(m.genMs) } }); }
        else if (m.type === "error") { done(); reject(new Error(m.message)); }
      };
      w.onerror = (e) => { done(); this.unload(true); reject(new Error(e.message || "image worker error")); };
      w.postMessage({ type: "generate", prompt });
    });
  }

  /**
   * Frees the image model's memory. The weights stay cached, so the next call loads in seconds.
   * Skipped while an image is being generated unless `force` is set.
   */
  unload(force = false) {
    if (this.active > 0 && !force) return;
    this.worker?.terminate();
    this.worker = undefined;
  }
}
