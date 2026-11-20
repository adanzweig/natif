import { MODEL_CATALOG, createCoreClient, MemoryStore, type DeviceProfile } from "@be-natif/core";
import { describe, expect, it, vi } from "vitest";
import { detectNativeDevice } from "../src/device";
import { LlamaRNEngine, type LlamaModule } from "../src/engine";
import type { ModelFiles } from "../src/files";
import { asyncStorageStore } from "../src/storage";

function memFiles(existing: string[] = []): ModelFiles & { downloads: string[] } {
  const set = new Set(existing);
  const downloads: string[] = [];
  return {
    dir: "/docs/models",
    downloads,
    exists: async (p) => set.has(p),
    freeBytes: async () => 50e9,
    ensureDir: async () => {},
    download: async (url, dest, onProgress) => {
      downloads.push(url);
      onProgress?.(0.5);
      onProgress?.(1);
      set.add(dest);
    },
    move: async (a, b) => {
      set.delete(a);
      set.add(b);
    },
    remove: async (p) => void set.delete(p),
  };
}

function fakeLlama(reply = '{"mood":3}') {
  const calls: Record<string, unknown>[] = [];
  const ctx = {
    completion: vi.fn(async (params: Record<string, unknown>, cb?: (d: { token: string }) => void) => {
      calls.push(params);
      for (const t of reply.match(/.{1,3}/g) ?? []) cb?.({ token: t });
      return { text: reply, content: reply, tokens_predicted: 8, tokens_evaluated: 40, tokens_cached: 32, timings: { predicted_per_second: 18, prompt_n: 8 } };
    }),
    stopCompletion: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const llama: LlamaModule = { initLlama: vi.fn(async (_p, onProgress) => (onProgress?.(50), onProgress?.(100), ctx)) };
  return { llama, ctx, calls };
}

const iphone: DeviceProfile = { platform: "ios", os: "ios 19", gpu: { available: true }, memoryGB: 12, availableMemoryMB: 7000, storageFreeBytes: 50e9 };

describe("LlamaRNEngine", () => {
  it("downloads once to a .part file, then loads from disk", async () => {
    const files = memFiles();
    const { llama } = fakeLlama();
    const engine = new LlamaRNEngine(llama, files);
    const id = engine.resolveModelId(MODEL_CATALOG[0]!, iphone)!;
    expect(id).toBe("Qwen3-4B-Q4_K_M");
    const phases: string[] = [];
    await engine.load(id, (p) => phases.push(p.phase));
    expect(files.downloads).toHaveLength(1);
    expect(await engine.isCached(id)).toBe(true);
    expect(await files.exists(`/docs/models/${id}.gguf.part`)).toBe(false);
    expect(phases).toEqual(["download", "download", "compile", "compile", "ready"]);
    await engine.unload();
    await engine.load(id);
    expect(files.downloads).toHaveLength(1);
  });

  it("skips models without a GGUF build", () => {
    const engine = new LlamaRNEngine(fakeLlama().llama, memFiles());
    expect(engine.resolveModelId(MODEL_CATALOG.find((m) => m.id === "gemma-4-e2b")!, iphone)).toBeUndefined();
  });

  it("streams tokens, sends the JSON schema and turns thinking off", async () => {
    const { llama, calls } = fakeLlama();
    const engine = new LlamaRNEngine(llama, memFiles());
    const id = engine.resolveModelId(MODEL_CATALOG[0]!, iphone)!;
    await engine.load(id);
    let streamed = "";
    const r = await engine.generate({ messages: [{ role: "user", content: "hi" }], maxTokens: 64, temperature: 0, jsonSchema: { type: "object" }, disableThinking: true, onToken: (d) => (streamed += d) });
    expect(streamed).toBe('{"mood":3}');
    expect(calls[0]).toMatchObject({ n_predict: 64, enable_thinking: false, response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } } });
    expect(r).toMatchObject({ completionTokens: 8, decodeTokPerSec: 18, cachedTokens: 32 });
  });

  it("works end to end through the core client (extract + chat)", async () => {
    const { z } = await import("zod");
    const { llama } = fakeLlama('{"mood":3}');
    const engine = new LlamaRNEngine(llama, memFiles());
    const ai = createCoreClient(
      { tasks: { t: { systemPrompt: "Score it" } }, idleUnloadMs: 0 },
      { sdkVersion: "test", detectDevice: async () => iphone, createTextEngine: () => engine, storage: new MemoryStore(), fetch: fetch },
    );
    const r = await ai.extractWithMeta({ task: "t", schema: z.object({ mood: z.number() }), input: { text: "meh" } });
    expect(r.data).toEqual({ mood: 3 });
    expect(r.meta.modelId).toBe("qwen3-4b");
    const c = await ai.chat({ message: "hola" });
    expect(c.history).toHaveLength(2);
  });

  it("picks the small model when the phone has little RAM available", async () => {
    const { llama } = fakeLlama('{"mood":3}');
    const engine = new LlamaRNEngine(llama, memFiles());
    const ai = createCoreClient({ idleUnloadMs: 0 }, { sdkVersion: "test", detectDevice: async () => ({ ...iphone, availableMemoryMB: 4000 }), createTextEngine: () => engine, storage: new MemoryStore(), fetch: fetch });
    expect((await ai.chat({ message: "hola" })).meta.modelId).toBe("qwen3-1.7b");
  });
});

describe("detectNativeDevice", () => {
  it("uses the app's own available-memory reading first, then the GPU limit", async () => {
    const base = { platform: "ios" as const, osVersion: "19.1", hardwareModel: () => "iPhone17,1", totalMemoryBytes: async () => 8 * 2 ** 30, freeStorageBytes: async () => 9e10, backendDevices: async () => [{ type: "gpu", deviceName: "Apple A18 Pro GPU", maxMemorySize: 5.5 * 2 ** 30 }] };
    expect(await detectNativeDevice({ ...base, availableMemoryMB: async () => 3100 })).toMatchObject({ availableMemoryMB: 3100, memoryGB: 8, hardwareModel: "iPhone17,1", gpu: { available: true } });
    expect((await detectNativeDevice(base)).availableMemoryMB).toBeCloseTo(5632);
    expect((await detectNativeDevice({ ...base, backendDevices: async () => [{ type: "cpu", deviceName: "CPU", maxMemorySize: 0 }] })).availableMemoryMB).toBeUndefined();
  });
});

describe("asyncStorageStore", () => {
  it("namespaces keys and clears only its own", async () => {
    const m = new Map<string, string>([["other", "1"]]);
    const s = asyncStorageStore({ getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async (k) => void m.delete(k), getAllKeys: async () => [...m.keys()] });
    await s.set("a", { x: 1 });
    expect(await s.get("a")).toEqual({ x: 1 });
    await s.clear();
    expect([...m.keys()]).toEqual(["other"]);
  });
});
