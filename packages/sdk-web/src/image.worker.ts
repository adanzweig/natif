/// <reference lib="webworker" />
// Text → image on WebGPU with Janus-Pro-1B (transformers.js). Runs in its own worker so its
// ONNX/WebGPU state never collides with the text model; terminating the worker frees the memory.
import { AutoProcessor, MultiModalityCausalLM } from "@huggingface/transformers";

export const IMAGE_MODEL = {
  id: "onnx-community/Janus-Pro-1B-ONNX",
  options: {
    dtype: { prepare_inputs_embeds: "q4", language_model: "q4f16", lm_head: "fp16", gen_head: "fp16", gen_img_embeds: "fp16", image_decode: "fp32" },
    device: { prepare_inputs_embeds: "wasm", language_model: "webgpu", lm_head: "webgpu", gen_head: "webgpu", gen_img_embeds: "webgpu", image_decode: "webgpu" },
  },
} as const;

type Out =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; loadMs: number }
  | { type: "image"; png: Blob; genMs: number; width: number; height: number }
  | { type: "error"; message: string };
const post = (m: Out) => (self as unknown as Worker).postMessage(m);

let ready: Promise<{ processor: any; model: any }> | undefined;
function load() {
  ready ??= (async () => {
    const t0 = performance.now();
    const files = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (e: any) => {
      if (e.status !== "progress" && e.status !== "done") return;
      const f = files.get(e.file) ?? { loaded: 0, total: e.total ?? 0 };
      if (e.status === "progress") { f.loaded = e.loaded ?? f.loaded; f.total = e.total ?? f.total; } else f.loaded = f.total;
      files.set(e.file, f);
      let loaded = 0, total = 0;
      for (const v of files.values()) { loaded += v.loaded; total += v.total; }
      post({ type: "progress", loaded, total });
    };
    const processor: any = await AutoProcessor.from_pretrained(IMAGE_MODEL.id, { progress_callback } as any);
    const model: any = await MultiModalityCausalLM.from_pretrained(IMAGE_MODEL.id, { progress_callback, ...IMAGE_MODEL.options } as any);
    post({ type: "ready", loadMs: performance.now() - t0 });
    return { processor, model };
  })();
  return ready;
}

self.onmessage = async (ev: MessageEvent<{ type: "generate"; prompt: string } | { type: "load" }>) => {
  try {
    const { processor, model } = await load();
    if (ev.data.type !== "generate") return;
    const inputs = await processor([{ role: "<|User|>", content: ev.data.prompt }], { chat_template: "text_to_image" });
    const n = processor.num_image_tokens;
    const t0 = performance.now();
    const [img] = await model.generate_images({ ...inputs, min_new_tokens: n, max_new_tokens: n, do_sample: true });
    post({ type: "image", png: await img.toBlob("image/png"), genMs: performance.now() - t0, width: img.width, height: img.height });
  } catch (e) {
    ready = undefined;
    post({ type: "error", message: (e as Error).message });
  }
};
