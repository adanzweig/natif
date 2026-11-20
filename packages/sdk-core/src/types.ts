import type { z } from "zod";

/** What an app declares it needs at init. The orchestrator picks one model per capability. */
export type Capability = "text" | "vision" | "audio-in" | "tts" | "image" | "video";

export type RuntimeMode = "auto" | "device-only" | "cloud-only";
export type RuntimeUsed = "device" | "cloud";

export interface Consent {
  /** User agreed that, if the device can't, the input may be sent to the cloud fallback. */
  cloudFallback: boolean;
  /** User agreed to anonymous performance telemetry (no content, ever). */
  telemetry: boolean;
}

/** Device class traits. Nothing here identifies a person. */
export interface DeviceProfile {
  platform: "web" | "ios" | "android" | "node";
  browser?: { name: string; major: number };
  os?: string;
  /** Hardware model on mobile, e.g. "iPhone16,2". */
  hardwareModel?: string;
  gpu: {
    available: boolean;
    vendor?: string;
    architecture?: string;
    shaderF16?: boolean;
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
  };
  /** Approximate total RAM in GB (navigator.deviceMemory is capped at 8 and Chromium-only). */
  memoryGB?: number;
  /**
   * RAM the app can use right now, in MB. Only native platforms can read it (iOS
   * os_proc_available_memory, Android ActivityManager.MemoryInfo.availMem); browsers can't.
   */
  availableMemoryMB?: number;
  storageFreeBytes?: number;
  connection?: { effectiveType?: string; saveData?: boolean };
}

export interface ModelSpec {
  id: string;
  family: string;
  capabilities: Capability[];
  tier: "high" | "low";
  license: string;
  /** Approximate download size of the default variant. */
  downloadBytes: number;
  /** Approximate GPU/RAM needed while running (weights + KV cache). */
  memoryRequiredMB: number;
  runtimes: {
    webllm?: { f16: string; f32?: string };
    gguf?: { url: string };
  };
  /** Higher = better output. Used to rank candidates that fit. */
  quality: number;
  /** Qwen3 thinking mode must be turned off for extraction. */
  disableThinking?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  messages: ChatMessage[];
  /** JSON Schema the output must follow (constrained decoding when the engine supports it). */
  jsonSchema?: Record<string, unknown>;
  maxTokens: number;
  temperature: number;
  disableThinking?: boolean;
  signal?: AbortSignal;
  /** Called with each new piece of text as it is generated (streaming). */
  onToken?: (delta: string) => void;
}

export interface GenerateResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  ttftMs: number;
  totalMs: number;
  decodeTokPerSec: number;
  /** Prompt tokens reused from the KV cache (prefix match), when the engine reports it. */
  cachedTokens?: number;
}

export interface LoadProgress {
  modelId: string;
  /** 0..1 */
  progress: number;
  phase: "download" | "compile" | "ready";
  text?: string;
}

/** Implemented by each platform (WebLLM in sdk-web, llama.rn in sdk-react-native, a mock in tests). */
export interface TextEngine {
  readonly name: string;
  /** Platform-specific model id for a catalog entry, or undefined if this engine can't run it. */
  resolveModelId(spec: ModelSpec, device: DeviceProfile): string | undefined;
  isCached(engineModelId: string): Promise<boolean>;
  load(engineModelId: string, onProgress?: (p: LoadProgress) => void): Promise<void>;
  /**
   * Optional: put the weights on disk without loading them into GPU/RAM, so a later `load` only
   * compiles. Must skip files already stored, so an interrupted download resumes where it stopped.
   */
  download?(engineModelId: string, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<void>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  unload(): Promise<void>;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface TaskConfig {
  slug: string;
  version: number;
  inputType: "text" | "audio" | "image";
  systemPrompt: string;
  instructions?: string;
  jsonSchema?: Record<string, unknown>;
  temperature: number;
  maxTokens: number;
  /** Below this decode speed the device is considered too slow for the task. */
  minDeviceTokPerSec: number;
  recommendedModel?: string;
  /** Set server-side when the project enforces local-only processing. */
  deviceOnly?: boolean;
}

export type FallbackReason =
  | "no_webgpu"
  | "insufficient_memory"
  | "insufficient_storage"
  | "no_model_for_capability"
  | "known_slow_device"
  | "benchmark_slow"
  | "load_failed"
  | "engine_error"
  | "schema_failed_after_repair"
  | "timeout"
  | "forced_cloud";

export interface ExtractInput {
  text?: string;
}

export interface ExtractRequest<S extends z.ZodType> {
  task: string;
  schema: S;
  input: ExtractInput;
  signal?: AbortSignal;
}

export interface ExtractMeta {
  modelId: string;
  runtime: RuntimeUsed;
  taskVersion: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  /** What the same call would have cost on the reference cloud model. Estimate. */
  estimatedSavingsUsd: number;
  fallbackReason?: FallbackReason;
  repaired?: boolean;
}

export interface ExtractResult<T> {
  data: T;
  meta: ExtractMeta;
}

export interface BenchmarkResult {
  modelId: string;
  decodeTokPerSec: number;
  ttftMs: number;
  at: number;
}

export interface ChatRequest {
  /** The new user message. */
  message: string;
  /**
   * Previous turns, owned by your app (persist it however you like). Keep it append-only:
   * engines reuse the cached prefix, so editing old turns or the system prompt makes the
   * whole conversation be processed again.
   */
  history?: ChatMessage[];
  /** System prompt. Keep it identical across turns so it stays cached. */
  system?: string;
  /**
   * Max previous messages sent to the model (default 20). When exceeded, the oldest are dropped
   * in one block (down to half), so the prefix stays stable and cached for the next turns.
   */
  maxHistoryMessages?: number;
  temperature?: number;
  maxTokens?: number;
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
  /** Override the client's `grounding` for this call ("off" skips knowledge). */
  grounding?: import("./knowledge").Grounding;
}

export interface ChatMeta {
  modelId: string;
  runtime: RuntimeUsed;
  latencyMs: number;
  ttftMs: number;
  tokensIn: number;
  tokensOut: number;
  decodeTokPerSec: number;
  estimatedSavingsUsd: number;
  /** Prompt tokens reused from the engine cache, when the engine reports it. */
  cachedTokens?: number;
  /** Older messages left out by maxHistoryMessages. */
  droppedMessages: number;
}

export interface ChatResult {
  text: string;
  /** history + the new user message + the reply. Pass it back on the next turn. */
  history: ChatMessage[];
  meta: ChatMeta;
  /** Passages from `knowledge` given to the model for this answer; `cited` marks the ones it used. */
  sources?: import("./knowledge").Source[];
}
