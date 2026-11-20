import { describe, expect, it, vi } from "vitest";
import { ImageEngine } from "../src/image";

class FakeWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  terminated = false;
  posted: any[] = [];
  postMessage(m: any) {
    this.posted.push(m);
    setTimeout(() => {
      this.onmessage?.({ data: { type: "progress", loaded: 50, total: 100 } } as MessageEvent);
      this.onmessage?.({ data: { type: "ready", loadMs: 1200 } } as MessageEvent);
      this.onmessage?.({ data: { type: "image", png: new Blob(["png"]), genMs: 900, width: 384, height: 384 } } as MessageEvent);
    }, 5);
  }
  terminate() { this.terminated = true; }
}

describe("ImageEngine", () => {
  it("returns the PNG and reports progress", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({}) } });
    const fw = new FakeWorker();
    const eng = new ImageEngine(() => fw as unknown as Worker);
    const progress: number[] = [];
    const r = await eng.generate({ prompt: "a pixel art knight", onProgress: (p) => progress.push(p.progress) });
    expect(r.width).toBe(384);
    expect(r.meta).toMatchObject({ runtime: "device", loadMs: 1200, genMs: 900 });
    expect(progress).toEqual([0.5, 1]);
    expect(fw.posted[0]).toEqual({ type: "generate", prompt: "a pixel art knight" });
  });

  it("does not unload while generating, unless forced", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({}) } });
    const fw = new FakeWorker();
    const eng = new ImageEngine(() => fw as unknown as Worker);
    const p = eng.generate({ prompt: "x" });
    eng.unload();
    expect(fw.terminated).toBe(false);
    await p;
    eng.unload();
    expect(fw.terminated).toBe(true);
  });

  it("needs WebGPU", async () => {
    vi.stubGlobal("navigator", {});
    await expect(new ImageEngine(() => new FakeWorker() as unknown as Worker).generate({ prompt: "x" })).rejects.toThrow(/no_webgpu|WebGPU/);
  });
});
