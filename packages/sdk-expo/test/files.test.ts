import { describe, expect, it } from "vitest";
import { expoModelFiles, type ExpoFs } from "../src/files";

// In-memory stand-in for expo-file-system's object API.
function fakeFs(opts: { failFirst?: boolean } = {}) {
  const disk = new Map<string, string>();
  const calls: string[] = [];
  let attempt = 0;
  class F {
    uri: string;
    constructor(...p: (string | { uri: string })[]) { this.uri = p.map((x) => (typeof x === "string" ? x : x.uri)).join("/").replace(/\/+/g, "/"); }
    get exists() { return disk.has(this.uri); }
    delete() { disk.delete(this.uri); }
    move(to: { uri: string }) { disk.set(to.uri, disk.get(this.uri)!); disk.delete(this.uri); }
    write(c: string) { disk.set(this.uri, c); }
    textSync() { return disk.get(this.uri)!; }
    static createDownloadTask(url: string, dest: F, o?: any) { return task(url, dest.uri, 0, o); }
  }
  function task(url: string, dest: string, from: number, o?: any) {
    let written = from;
    return {
      async downloadAsync() { calls.push(`start ${from}`); return run(); },
      async resumeAsync() { calls.push(`resume ${written}`); return run(); },
      async pauseAsync() { calls.push("pause"); },
      cancel() {},
      savable: () => ({ url, dest, written }),
    };
    async function run() {
      attempt++;
      written = Math.max(written, 40);
      o?.onProgress?.({ bytesWritten: written, totalBytes: 100 });
      if (opts.failFirst && attempt === 1) throw new Error("network lost");
      written = 100;
      o?.onProgress?.({ bytesWritten: 100, totalBytes: 100 });
      disk.set(dest, "gguf");
      return { uri: dest };
    }
  }
  const fs = {
    File: F,
    Directory: class extends F { create() {} },
    Paths: { document: { uri: "/docs" }, availableDiskSpace: 5e9 },
    DownloadTask: { fromSavable: (s: any, o?: any) => task(s.url, s.dest, s.written, o) },
  } as unknown as ExpoFs;
  return { fs, disk, calls };
}

describe("expoModelFiles", () => {
  it("downloads into the app documents folder and reports progress", async () => {
    const { fs, disk } = fakeFs();
    const files = expoModelFiles(fs);
    expect(files.dir).toBe("/docs/natif-models");
    const seen: number[] = [];
    await files.download("https://hf.co/m.gguf", `${files.dir}/m.gguf.part`, (f) => seen.push(f));
    expect(disk.get("/docs/natif-models/m.gguf.part")).toBe("gguf");
    expect(seen.at(-1)).toBe(1);
    expect(files.resumes).toBe(true);
  });

  it("saves the paused state on abort and resumes from it on the next attempt", async () => {
    const { fs, disk, calls } = fakeFs({ failFirst: true });
    const files = expoModelFiles(fs);
    const dest = `${files.dir}/m.gguf.part`;
    const ac = new AbortController();
    const first = files.download("https://hf.co/m.gguf", dest, undefined, ac.signal);
    ac.abort();
    await expect(first).rejects.toThrow();
    expect(disk.has(`${dest}.resume.json`)).toBe(true);
    await files.download("https://hf.co/m.gguf", dest);
    expect(calls).toContain("resume 40");
    expect(disk.has(`${dest}.resume.json`)).toBe(false);
    expect(disk.get(dest)).toBe("gguf");
  });
});
