import type { DeviceProfile, GenerateRequest, GenerateResult, ModelSpec, PlatformAdapter, TextEngine } from "../src";
import { MemoryStore } from "../src";

export const highEndWeb: DeviceProfile = {
  platform: "web",
  browser: { name: "chrome", major: 157 },
  gpu: { available: true, vendor: "apple", architecture: "metal-3", shaderF16: true, maxBufferSize: 4 * 2 ** 30 },
  memoryGB: 8,
  storageFreeBytes: 100e9,
};

export class MockEngine implements TextEngine {
  name = "mock";
  loads: string[] = [];
  loadOpts: unknown[] = [];
  calls: GenerateRequest[] = [];
  cached = new Set<string>();
  failLoad = new Set<string>();
  current?: string;
  constructor(
    public reply: (req: GenerateRequest, n: number) => string = () => "{}",
    public tokPerSec: Record<string, number> = {},
  ) {}
  resolveModelId(spec: ModelSpec) {
    return spec.runtimes.webllm?.f16;
  }
  async isCached(id: string) {
    return this.cached.has(id);
  }
  async load(id: string, _p?: unknown, opts?: unknown) {
    if (this.failLoad.has(id)) throw new Error("load failed");
    this.loadOpts.push(opts);
    this.loads.push(id);
    this.current = id;
    this.cached.add(id);
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    const isBench = !req.jsonSchema;
    const text = isBench ? "the sky is blue because" : this.reply(req, this.calls.filter((c) => c.jsonSchema).length);
    return { text, promptTokens: 100, completionTokens: 20, ttftMs: 50, totalMs: 500, decodeTokPerSec: this.tokPerSec[this.current!] ?? 40 };
  }
  async unload() {
    this.current = undefined;
  }
}

export function platform(engine: TextEngine, device: DeviceProfile = highEndWeb, fetchImpl?: typeof fetch): PlatformAdapter & { sent: unknown[][] } {
  const sent: unknown[][] = [];
  return {
    sdkVersion: "0.1.0",
    detectDevice: async () => device,
    createTextEngine: () => engine,
    storage: new MemoryStore(),
    fetch: fetchImpl ?? (async () => new Response("not found", { status: 404 })),
    telemetryTransport: () => ({ send: (events) => void sent.push(events) }),
    sent,
  };
}
