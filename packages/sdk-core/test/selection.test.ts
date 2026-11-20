import { describe, expect, it } from "vitest";
import { decideRuntime, memoryBudgetMB, MODEL_CATALOG, selectModel } from "../src";
import { highEndWeb } from "./helpers";

const engine = { resolveModelId: (s: (typeof MODEL_CATALOG)[number]) => s.runtimes.webllm?.f16 };
const base = { capability: "text" as const, catalog: MODEL_CATALOG, engine, minDeviceTokPerSec: 8 };

describe("selectModel", () => {
  it("picks the best model that fits a high-end device", () => {
    const r = selectModel({ ...base, device: highEndWeb });
    expect(r.ok && r.spec.id).toBe("qwen3-4b");
  });

  it("no WebGPU on web → no_webgpu", () => {
    const r = selectModel({ ...base, device: { ...highEndWeb, gpu: { available: false } } });
    expect(r).toMatchObject({ ok: false, reason: "no_webgpu" });
  });

  it("4 GB of RAM steps down to the low tier", () => {
    const r = selectModel({ ...base, device: { ...highEndWeb, memoryGB: 4 } });
    expect(r.ok && r.spec.id).toBe("qwen3-1.7b");
  });

  it("2 GB of RAM → insufficient_memory", () => {
    const r = selectModel({ ...base, device: { ...highEndWeb, memoryGB: 2 } });
    expect(r).toMatchObject({ ok: false, reason: "insufficient_memory" });
  });

  it("unknown memory (Safari) does not block", () => {
    const { memoryGB, ...rest } = highEndWeb;
    const r = selectModel({ ...base, device: rest });
    expect(r.ok && r.spec.id).toBe("qwen3-4b");
  });

  it("low storage blocks models that are not downloaded yet, but not cached ones", () => {
    const device = { ...highEndWeb, storageFreeBytes: 1e9 };
    expect(selectModel({ ...base, device })).toMatchObject({ ok: false, reason: "insufficient_storage" });
    const r = selectModel({ ...base, device, cached: new Set(["Qwen3-4B-q4f16_1-MLC"]) });
    expect(r.ok && r.spec.id).toBe("qwen3-4b");
  });

  it("a slow local benchmark skips that model", () => {
    const r = selectModel({
      ...base,
      device: highEndWeb,
      benchmarks: { "qwen3-4b": { modelId: "qwen3-4b", decodeTokPerSec: 3, ttftMs: 900, at: 0 } },
    });
    expect(r.ok && r.spec.id).toBe("gemma-4-e2b");
  });

  it("all models slow → benchmark_slow", () => {
    const slow = { decodeTokPerSec: 1, ttftMs: 1, at: 0 };
    const r = selectModel({
      ...base,
      device: highEndWeb,
      benchmarks: Object.fromEntries(MODEL_CATALOG.map((m) => [m.id, { ...slow, modelId: m.id }])),
    });
    expect(r).toMatchObject({ ok: false, reason: "benchmark_slow" });
  });

  it("server recommendation marks a device class as slow; a local benchmark overrides it", () => {
    const recommendation = { models: { "qwen3-4b": { p50DecodeTokPerSec: 4 } } };
    const r1 = selectModel({ ...base, device: highEndWeb, recommendation });
    expect(r1.ok && r1.spec.id).toBe("gemma-4-e2b");
    expect(r1.rejected["qwen3-4b"]).toBe("known_slow_device");
    const r2 = selectModel({
      ...base,
      device: highEndWeb,
      recommendation,
      benchmarks: { "qwen3-4b": { modelId: "qwen3-4b", decodeTokPerSec: 30, ttftMs: 1, at: 0 } },
    });
    expect(r2.ok && r2.spec.id).toBe("qwen3-4b");
  });

  it("preferred model goes first when it fits", () => {
    const r = selectModel({ ...base, device: highEndWeb, preferredModel: "gemma-4-e2b" });
    expect(r.ok && r.spec.id).toBe("gemma-4-e2b");
  });

  it("vision only matches multimodal models", () => {
    const r = selectModel({ ...base, capability: "vision", device: highEndWeb });
    expect(r.ok && r.spec.id).toBe("gemma-4-e2b");
  });
});

describe("decideRuntime", () => {
  const yes = { cloudFallback: true, telemetry: false };
  const no = { cloudFallback: false, telemetry: false };
  const cases: [string, Parameters<typeof decideRuntime>[0], ReturnType<typeof decideRuntime>][] = [
    ["device works", { mode: "auto", consent: yes, taskDeviceOnly: false, deviceFailure: null }, { runtime: "device" }],
    ["device fails + consent", { mode: "auto", consent: yes, taskDeviceOnly: false, deviceFailure: "no_webgpu" }, { runtime: "cloud", reason: "no_webgpu" }],
    ["device fails, no consent", { mode: "auto", consent: no, taskDeviceOnly: false, deviceFailure: "no_webgpu" }, { runtime: "none", reason: "no_webgpu" }],
    ["device-only project wins over consent", { mode: "auto", consent: yes, taskDeviceOnly: true, deviceFailure: "timeout" }, { runtime: "none", reason: "timeout" }],
    ["client device-only", { mode: "device-only", consent: yes, taskDeviceOnly: false, deviceFailure: "oom" as never }, { runtime: "none", reason: "oom" as never }],
    ["cloud-only", { mode: "cloud-only", consent: yes, taskDeviceOnly: false, deviceFailure: null }, { runtime: "cloud", reason: "forced_cloud" }],
    ["cloud-only on a device-only project", { mode: "cloud-only", consent: yes, taskDeviceOnly: true, deviceFailure: null }, { runtime: "none", reason: "forced_cloud" }],
  ];
  it.each(cases)("%s", (_, input, expected) => expect(decideRuntime(input)).toEqual(expected));
});

describe("memory budget (use what's free, not what's installed)", () => {
  it("64 GB machine with only 10 GB available still runs the 4B model (6 GB budget)", () => {
    const r = selectModel({ ...base, device: { ...highEndWeb, memoryGB: 64, availableMemoryMB: 10_240 } });
    expect(r.ok && r.spec.id).toBe("qwen3-4b");
  });
  it("only 4 GB available → steps down to the small model", () => {
    const r = selectModel({ ...base, device: { ...highEndWeb, memoryGB: 64, availableMemoryMB: 4_096 } });
    expect(r.ok && r.spec.id).toBe("qwen3-1.7b");
  });
  it("only 2 GB available → nothing local", () => {
    const r = selectModel({ ...base, device: { ...highEndWeb, memoryGB: 64, availableMemoryMB: 2_048 } });
    expect(r).toMatchObject({ ok: false, reason: "insufficient_memory" });
  });
  it("the app's explicit budget wins", () => {
    const r = selectModel({ ...base, device: highEndWeb, memoryBudgetMB: 2_500 });
    expect(r.ok && r.spec.id).toBe("qwen3-1.7b");
  });
});

describe("web: free memory unknown", () => {
  it("a browser reporting 32 GB total is still capped at 4 GB per model", () => {
    expect(memoryBudgetMB({ ...highEndWeb, memoryGB: 32 })).toBe(4096);
  });
  it("no memory info at all (Safari) → the same safe cap", () => {
    const { memoryGB, ...rest } = highEndWeb;
    expect(memoryBudgetMB(rest)).toBe(4096);
  });
});
