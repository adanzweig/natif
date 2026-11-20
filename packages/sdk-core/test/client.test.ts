import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCoreClient, DeviceUnavailableError, SchemaValidationError, trimHistory } from "../src";
import { highEndWeb, MockEngine, platform } from "./helpers";

const CheckIn = z.object({
  mood: z.number().int().min(1).max(10),
  energy: z.number().int().min(1).max(10),
  stress: z.number().int().min(1).max(10),
  emotions: z.array(z.string()).max(5),
});
const VALID = '{"mood":3,"energy":4,"stress":8,"emotions":["ansiedad"]}';
const tasks = { "daily-checkin": { systemPrompt: "Puntuá el check-in." } };
const input = { text: "Dormí mal, mucha ansiedad por el trabajo." };
const req = { task: "daily-checkin", schema: CheckIn, input };

function cloudFetch(calls: unknown[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/v1/fallback/extract")) {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ data: JSON.parse(VALID), model: "claude-haiku-5-5", usage: { inputTokens: 300, outputTokens: 30 } });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

describe("extract on device", () => {
  it("returns typed data and meta", async () => {
    const engine = new MockEngine(() => VALID);
    const ai = createCoreClient({ tasks }, platform(engine));
    const { data, meta } = await ai.extractWithMeta(req);
    expect(data).toEqual(JSON.parse(VALID));
    expect(meta).toMatchObject({ runtime: "device", modelId: "qwen3-4b", tokensIn: 100, tokensOut: 20 });
    expect(meta.estimatedSavingsUsd).toBeGreaterThan(0);
    const call = engine.calls.find((c) => c.jsonSchema)!;
    expect(call.temperature).toBe(0);
    expect(call.disableThinking).toBe(true);
    expect(call.messages[1]!.content).toBe(input.text);
  });

  it("repairs once when the first answer is invalid", async () => {
    const engine = new MockEngine((_, n) => (n === 1 ? '{"mood":42}' : VALID));
    const ai = createCoreClient({ tasks }, platform(engine));
    const { meta } = await ai.extractWithMeta(req);
    expect(meta.repaired).toBe(true);
    const repair = engine.calls.filter((c) => c.jsonSchema)[1]!;
    expect(repair.messages.at(-1)!.content).toContain("not valid");
  });

  it("loads and benchmarks only once across concurrent calls", async () => {
    const engine = new MockEngine(() => VALID);
    const ai = createCoreClient({ tasks }, platform(engine));
    await Promise.all([ai.extract(req), ai.extract(req), ai.extract(req)]);
    expect(engine.loads).toEqual(["Qwen3-4B-q4f16_1-MLC"]);
    expect(engine.calls.filter((c) => !c.jsonSchema)).toHaveLength(1);
  });

  it("steps down when the benchmark is too slow", async () => {
    const engine = new MockEngine(() => VALID, { "Qwen3-4B-q4f16_1-MLC": 3 });
    const ai = createCoreClient({ tasks }, platform(engine));
    const { meta } = await ai.extractWithMeta(req);
    expect(meta.modelId).toBe("gemma-4-e2b");
    expect(engine.loads).toEqual(["Qwen3-4B-q4f16_1-MLC", "gemma-4-E2B-it-q4f16_1-MLC"]);
  });

  it("steps down when a model fails to load", async () => {
    const engine = new MockEngine(() => VALID);
    engine.failLoad.add("Qwen3-4B-q4f16_1-MLC");
    const ai = createCoreClient({ tasks }, platform(engine));
    expect((await ai.extractWithMeta(req)).meta.modelId).toBe("gemma-4-e2b");
  });

  it("eager preload starts loading at init", async () => {
    const engine = new MockEngine(() => VALID);
    createCoreClient({ tasks, preload: "eager" }, platform(engine));
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.loads).toHaveLength(1);
  });
});

describe("fallback", () => {
  const cloudOpts = { tasks, apiKey: "pk_test_1", baseUrl: "https://api.example.test" };

  it("no WebGPU + consent → cloud, with the JSON Schema", async () => {
    const calls: any[] = [];
    const engine = new MockEngine();
    const ai = createCoreClient({ ...cloudOpts, consent: { cloudFallback: true } }, platform(engine, { ...highEndWeb, gpu: { available: false } }, cloudFetch(calls)));
    const { data, meta } = await ai.extractWithMeta(req);
    expect(data.stress).toBe(8);
    expect(meta).toMatchObject({ runtime: "cloud", fallbackReason: "no_webgpu", estimatedSavingsUsd: 0 });
    expect(calls[0].jsonSchema.type).toBe("object");
    expect(engine.loads).toHaveLength(0);
  });

  it("no WebGPU without consent → DeviceUnavailableError and nothing is sent", async () => {
    const calls: unknown[] = [];
    const ai = createCoreClient(cloudOpts, platform(new MockEngine(), { ...highEndWeb, gpu: { available: false } }, cloudFetch(calls)));
    await expect(ai.extract(req)).rejects.toBeInstanceOf(DeviceUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("schema fails twice: cloud with consent, SchemaValidationError without", async () => {
    const calls: unknown[] = [];
    const bad = () => '{"mood":99}';
    const withConsent = createCoreClient({ ...cloudOpts, consent: { cloudFallback: true } }, platform(new MockEngine(bad), highEndWeb, cloudFetch(calls)));
    expect((await withConsent.extractWithMeta(req)).meta.fallbackReason).toBe("schema_failed_after_repair");
    const without = createCoreClient(cloudOpts, platform(new MockEngine(bad), highEndWeb, cloudFetch(calls)));
    await expect(without.extract(req)).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("a device-only task never reaches the cloud, even with consent", async () => {
    const calls: unknown[] = [];
    const ai = createCoreClient(
      { ...cloudOpts, consent: { cloudFallback: true }, tasks: { "daily-checkin": { systemPrompt: "x", deviceOnly: true } } },
      platform(new MockEngine(), { ...highEndWeb, gpu: { available: false } }, cloudFetch(calls)),
    );
    await expect(ai.extract(req)).rejects.toMatchObject({ reason: "no_webgpu" });
    expect(calls).toHaveLength(0);
  });

  it("engine timeout → timeout reason", async () => {
    const engine = new MockEngine(() => VALID);
    const realGenerate = engine.generate.bind(engine);
    engine.generate = async (r) => (r.jsonSchema ? new Promise(() => {}) : realGenerate(r));
    const ai = createCoreClient({ tasks, timeoutMs: 20 }, platform(engine));
    await expect(ai.extract(req)).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("telemetry from the client", () => {
  it("sends metadata only, never the input or the result", async () => {
    const p = platform(new MockEngine(() => VALID));
    const ai = createCoreClient({ tasks, apiKey: "pk_test_1", baseUrl: "https://api.example.test", consent: { telemetry: true } }, p);
    await ai.extract(req);
    await ai.flushTelemetry();
    const sent = JSON.stringify(p.sent);
    expect(p.sent.flat()).toHaveLength(1);
    expect(sent).toContain('"modelId":"qwen3-4b"');
    expect(sent).not.toContain("ansiedad");
    expect(sent).not.toContain("Dormí");
  });

  it("sends nothing without telemetry consent", async () => {
    const p = platform(new MockEngine(() => VALID));
    const ai = createCoreClient({ tasks, apiKey: "pk_test_1", baseUrl: "https://api.example.test" }, p);
    await ai.extract(req);
    await ai.flushTelemetry();
    expect(p.sent).toHaveLength(0);
  });
});

describe("tasks from the backend", () => {
  it("uses the ETag cache and works offline with the last version", async () => {
    let online = true;
    let hits = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (!online) throw new TypeError("network down");
      hits++;
      const etag = '"v2"';
      if ((init?.headers as Record<string, string>)["if-none-match"] === etag) return new Response(null, { status: 304 });
      return Response.json({ task: { slug: "daily-checkin", version: 2, systemPrompt: "remote" } }, { headers: { etag } });
    }) as typeof fetch;
    const p = platform(new MockEngine(() => VALID), highEndWeb, fetchImpl);
    const opts = { apiKey: "pk_test_1", baseUrl: "https://api.example.test" };
    const a = createCoreClient(opts, p);
    expect((await a.extractWithMeta(req)).meta.taskVersion).toBe(2);
    const b = createCoreClient(opts, p); // same storage, new session
    expect((await b.extractWithMeta(req)).meta.taskVersion).toBe(2);
    expect(hits).toBe(2);
    online = false;
    const c = createCoreClient(opts, p);
    expect((await c.extractWithMeta(req)).meta.taskVersion).toBe(2);
  });
});

describe("idle unload frees memory", () => {
  it("unloads after idleUnloadMs without use, and reloads on the next call", async () => {
    const engine = new MockEngine(() => VALID);
    const ai = createCoreClient({ tasks, idleUnloadMs: 30 }, platform(engine));
    await ai.extract(req);
    expect(engine.current).toBeDefined();
    await new Promise((r) => setTimeout(r, 60));
    expect(engine.current).toBeUndefined();
    await ai.extract(req);
    expect(engine.loads).toHaveLength(2);
  });
});

describe("chat", () => {
  it("streams tokens, hides think tags and returns the updated history", async () => {
    const engine = new MockEngine();
    let sent: unknown;
    engine.generate = async (req) => {
      sent = req.messages;
      for (const d of ["<think>hmm</think>", "Hola", ", ¿cómo", " estás?"]) req.onToken?.(d);
      return { text: "<think>hmm</think>Hola, ¿cómo estás?", promptTokens: 30, completionTokens: 6, ttftMs: 40, totalMs: 200, decodeTokPerSec: 40, cachedTokens: 12 };
    };
    const ai = createCoreClient({ idleUnloadMs: 0 }, platform(engine));
    const seen: string[] = [];
    const history = [{ role: "assistant" as const, content: "¡Buenas!" }];
    const r = await ai.chat({ system: "Sé amable", history, message: "hola", onToken: (d) => seen.push(d) });
    expect(seen.join("")).toBe("Hola, ¿cómo estás?");
    expect(sent).toEqual([{ role: "system", content: "Sé amable" }, ...history, { role: "user", content: "hola" }]);
    expect(r.history).toEqual([...history, { role: "user", content: "hola" }, { role: "assistant", content: "Hola, ¿cómo estás?" }]);
    expect(r.meta).toMatchObject({ runtime: "device", cachedTokens: 12, droppedMessages: 0 });
  });

  it("throws DeviceUnavailableError without WebGPU", async () => {
    const ai = createCoreClient({}, platform(new MockEngine(), { ...highEndWeb, gpu: { available: false } }));
    await expect(ai.chat({ message: "hola" })).rejects.toThrow(/no_webgpu/);
  });
});

describe("trimHistory (cache-friendly)", () => {
  const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: String(i) }));
  it("keeps everything under the limit", () => {
    expect(trimHistory(turns(20), 20)).toEqual({ kept: turns(20), dropped: 0 });
  });
  it("drops in blocks so the prefix stays the same for several turns", () => {
    const starts = [22, 24, 26, 28].map((n) => trimHistory(turns(n), 20).kept[0]!.content);
    expect(new Set(starts).size).toBe(1);
    for (const n of [21, 25, 29, 33, 40, 57]) {
      const { kept, dropped } = trimHistory(turns(n), 20);
      expect(kept.length).toBeLessThanOrEqual(20);
      expect(kept[0]!.role).toBe("user");
      expect(dropped + kept.length).toBe(n);
    }
  });
});

describe("classify", () => {
  it("picks one label on the device with a built-in task and an enum schema", async () => {
    const engine = new MockEngine(() => '{"label":"billing"}');
    const ai = createCoreClient({}, platform(engine));
    const r = await ai.classify({ text: "I was charged twice", labels: ["billing", "bug", "feature"] });
    expect(r.label).toBe("billing");
    expect(r.meta.runtime).toBe("device");
    const call = engine.calls.find((c) => c.jsonSchema)!;
    expect(JSON.stringify(call.jsonSchema)).toContain('"enum":["billing","bug","feature"]');
    expect(call.messages.at(-1)!.content).toContain("Labels: billing | bug | feature");
  });

  it("rejects a label outside the list (validation) and bad input", async () => {
    const ai = createCoreClient({}, platform(new MockEngine(() => '{"label":"spam"}')));
    await expect(ai.classify({ text: "hi", labels: ["a", "b"] })).rejects.toThrow();
    await expect(ai.classify({ text: "hi", labels: ["only"] })).rejects.toThrow(/2 labels/);
  });
});
