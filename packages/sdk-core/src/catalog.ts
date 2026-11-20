import type { ModelSpec } from "./types";

/**
 * Curated models. Only licenses that allow commercial use without passing extra terms to the
 * app's users (Apache-2.0 / MIT). Numbers come from WebLLM's prebuilt config and spikes/.
 */
export const MODEL_CATALOG: readonly ModelSpec[] = [
  {
    id: "qwen3-4b",
    family: "qwen3",
    capabilities: ["text"],
    tier: "high",
    license: "Apache-2.0",
    downloadBytes: 2.3e9,
    memoryRequiredMB: 3432,
    runtimes: {
      webllm: { f16: "Qwen3-4B-q4f16_1-MLC", f32: "Qwen3-4B-q4f32_1-MLC" },
      gguf: { url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf" },
    },
    quality: 90,
    disableThinking: true,
  },
  {
    id: "gemma-4-e2b",
    family: "gemma4",
    capabilities: ["text", "vision"],
    tier: "high",
    license: "Apache-2.0",
    downloadBytes: 2.6e9,
    memoryRequiredMB: 3388,
    runtimes: { webllm: { f16: "gemma-4-E2B-it-q4f16_1-MLC", f32: "gemma-4-E2B-it-q4f32_1-MLC" } },
    quality: 85,
  },
  {
    id: "qwen3-1.7b",
    family: "qwen3",
    capabilities: ["text"],
    tier: "low",
    license: "Apache-2.0",
    downloadBytes: 1.1e9,
    memoryRequiredMB: 2037,
    runtimes: {
      webllm: { f16: "Qwen3-1.7B-q4f16_1-MLC", f32: "Qwen3-1.7B-q4f32_1-MLC" },
      gguf: { url: "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf" },
    },
    quality: 55,
    disableThinking: true,
  },
];

export function findModel(id: string, catalog: readonly ModelSpec[] = MODEL_CATALOG): ModelSpec | undefined {
  return catalog.find((m) => m.id === id);
}
