import type {
  BenchmarkResult,
  Capability,
  Consent,
  DeviceProfile,
  FallbackReason,
  ModelSpec,
  RuntimeMode,
  TextEngine,
} from "./types";

export const STORAGE_HEADROOM = 1.2;
/** Share of *available* memory a model may take (native platforms report it). */
export const AVAILABLE_MEMORY_SHARE = 0.6;
/** Share of *total* memory when available memory is unknown (browsers): conservative on purpose. */
export const TOTAL_MEMORY_SHARE = 0.5;
/** Max budget when free memory is unknown (web): fits the 4B tier, never more. */
export const UNKNOWN_FREE_MEMORY_CAP_MB = 4096;

/**
 * How much memory (MB) a model may use on this device, so we never slow the user's computer down.
 * Order: what the app says → what the OS says is available → a share of the total → unknown.
 */
export function memoryBudgetMB(device: DeviceProfile, override?: number): number {
  if (override !== undefined) return override;
  if (device.availableMemoryMB !== undefined) return device.availableMemoryMB * AVAILABLE_MEMORY_SHARE;
  // Without real free memory (browsers), never assume more than a safe cap: a 64 GB machine may
  // have only a few GB free, and taking too much makes the user's whole computer slow.
  if (device.memoryGB !== undefined) return Math.min(device.memoryGB * 1024 * TOTAL_MEMORY_SHARE, UNKNOWN_FREE_MEMORY_CAP_MB);
  return UNKNOWN_FREE_MEMORY_CAP_MB;
}

export interface DeviceRecommendation {
  /** Aggregated from anonymous telemetry of devices in the same class (n ≥ 20). */
  models: Record<string, { p50DecodeTokPerSec: number; loadFailRate?: number }>;
}

export interface SelectModelInput {
  device: DeviceProfile;
  capability: Capability;
  catalog: readonly ModelSpec[];
  engine: Pick<TextEngine, "resolveModelId">;
  minDeviceTokPerSec: number;
  /** Engine model ids already downloaded (storage check is skipped for them). */
  cached?: ReadonlySet<string>;
  benchmarks?: Readonly<Record<string, BenchmarkResult>>;
  recommendation?: DeviceRecommendation;
  /** Task or app preference; tried first if it fits. */
  preferredModel?: string;
  /** Max memory (MB) a model may use; overrides what is derived from the device. */
  memoryBudgetMB?: number;
}

export type ModelSelection =
  | { ok: true; spec: ModelSpec; engineModelId: string; rejected: Record<string, FallbackReason> }
  | { ok: false; reason: FallbackReason; rejected: Record<string, FallbackReason> };

/** When every candidate is rejected, report the reason that best explains it. */
const REASON_PRIORITY: FallbackReason[] = [
  "benchmark_slow",
  "known_slow_device",
  "insufficient_memory",
  "insufficient_storage",
  "no_model_for_capability",
];

/** Pure: picks the best model this device can run for a capability, or explains why none. */
export function selectModel(input: SelectModelInput): ModelSelection {
  const { device, capability, catalog, engine, minDeviceTokPerSec } = input;
  const rejected: Record<string, FallbackReason> = {};

  if (device.platform === "web" && !device.gpu.available) {
    return { ok: false, reason: "no_webgpu", rejected };
  }

  const candidates = catalog
    .filter((m) => m.capabilities.includes(capability))
    .sort((a, b) => {
      if (a.id === input.preferredModel) return -1;
      if (b.id === input.preferredModel) return 1;
      return b.quality - a.quality;
    });

  const budget = memoryBudgetMB(device, input.memoryBudgetMB);
  for (const spec of candidates) {
    const engineModelId = engine.resolveModelId(spec, device);
    if (!engineModelId) {
      rejected[spec.id] = "no_model_for_capability";
      continue;
    }
    if (spec.memoryRequiredMB > budget) {
      rejected[spec.id] = "insufficient_memory";
      continue;
    }
    const isCached = input.cached?.has(engineModelId) ?? false;
    if (!isCached && device.storageFreeBytes !== undefined && device.storageFreeBytes < spec.downloadBytes * STORAGE_HEADROOM) {
      rejected[spec.id] = "insufficient_storage";
      continue;
    }
    const bench = input.benchmarks?.[spec.id];
    if (bench && bench.decodeTokPerSec < minDeviceTokPerSec) {
      rejected[spec.id] = "benchmark_slow";
      continue;
    }
    const rec = input.recommendation?.models[spec.id];
    if (!bench && rec && rec.p50DecodeTokPerSec < minDeviceTokPerSec) {
      rejected[spec.id] = "known_slow_device";
      continue;
    }
    return { ok: true, spec, engineModelId, rejected };
  }

  const reasons = new Set(Object.values(rejected));
  const reason = REASON_PRIORITY.find((r) => reasons.has(r)) ?? "no_model_for_capability";
  return { ok: false, reason, rejected };
}

export type RuntimeDecision =
  | { runtime: "device" }
  | { runtime: "cloud"; reason: FallbackReason }
  | { runtime: "none"; reason: FallbackReason };

/**
 * Pure: given why the device can't (or null if it can), decide where to run.
 * A device-only project never reaches the cloud, whatever the client asks.
 */
export function decideRuntime(opts: {
  mode: RuntimeMode;
  consent: Consent;
  taskDeviceOnly: boolean;
  deviceFailure: FallbackReason | null;
}): RuntimeDecision {
  const cloudAllowed = opts.consent.cloudFallback && !opts.taskDeviceOnly && opts.mode !== "device-only";
  if (opts.mode === "cloud-only") {
    return cloudAllowed ? { runtime: "cloud", reason: "forced_cloud" } : { runtime: "none", reason: "forced_cloud" };
  }
  if (opts.deviceFailure === null) return { runtime: "device" };
  return cloudAllowed ? { runtime: "cloud", reason: opts.deviceFailure } : { runtime: "none", reason: opts.deviceFailure };
}
