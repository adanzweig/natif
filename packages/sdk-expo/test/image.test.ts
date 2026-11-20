import { describe, expect, it, vi } from "vitest";
import { NativeImageEngine, toPath, type NativeImageModuleLike } from "../src/image";

function memFiles() {
  const disk = new Set<string>();
  return {
    disk,
    files: {
      dir: "file:///docs/natif-models",
      resumes: true,
      exists: async (p: string) => disk.has(p),
      freeBytes: async () => 10e9,
      ensureDir: async () => {},
      download: vi.fn(async (_url: string, dest: string, onProgress?: (f: number) => void) => { onProgress?.(0.5); onProgress?.(1); disk.add(dest); }),
      move: async (a: string, b: string) => { disk.delete(a); disk.add(b); },
      remove: async (p: string) => { disk.delete(p); },
    },
  };
}

function fakeNative() {
  const listeners: ((e: { step: number; steps: number }) => void)[] = [];
  const native: NativeImageModuleLike & { calls: any[]; unloads: number } = {
    calls: [],
    unloads: 0,
    async generate(o) {
      native.calls.push(o);
      listeners.forEach((l) => l({ step: 2, steps: 4 }));
      return { path: o.outPath as string, width: 384, height: 384, genMs: 4300 };
    },
    async unload() { native.unloads++; },
    cancel() {},
    addListener(_e, cb) { listeners.push(cb); return { remove: () => listeners.splice(listeners.indexOf(cb), 1) }; },
  };
  return native;
}

describe("NativeImageEngine (Expo)", () => {
  it("downloads the model once, passes plain paths to native code and returns a file URI", async () => {
    const { files } = memFiles();
    const native = fakeNative();
    const eng = new NativeImageEngine(native, files, "file:///cache");
    const phases: string[] = [];
    const r = await eng.generate({ prompt: "pixel knight", onProgress: (p) => phases.push(p.phase) });
    expect(native.calls[0].modelPath).toBe("/docs/natif-models/sd_turbo-f16-q8_0.gguf");
    expect(native.calls[0].outPath).toMatch(/^\/cache\/natif-image-.*\.png$/);
    expect(native.calls[0]).toMatchObject({ width: 384, height: 384, steps: 4, cfgScale: 1 });
    expect(r.uri).toMatch(/^file:\/\/\/cache\/natif-image-/);
    expect(phases).toContain("download");
    expect(phases.at(-1)).toBe("ready");
    await eng.generate({ prompt: "again" });
    expect(files.download).toHaveBeenCalledTimes(1);
  });

  it("unload only calls native when a model is loaded", async () => {
    const { files } = memFiles();
    const native = fakeNative();
    const eng = new NativeImageEngine(native, files, "/cache");
    await eng.unload();
    expect(native.unloads).toBe(0);
    await eng.generate({ prompt: "x" });
    await eng.unload();
    expect(native.unloads).toBe(1);
  });

  it("explains when the native module is missing (Expo Go)", async () => {
    const { files } = memFiles();
    await expect(new NativeImageEngine(null, files, "/cache").generate({ prompt: "x" })).rejects.toThrow(/development build/);
  });

  it("toPath strips file:// and decodes", () => {
    expect(toPath("file:///var/mobile/My%20App/a.png")).toBe("/var/mobile/My App/a.png");
    expect(toPath("/already/path")).toBe("/already/path");
  });
});
