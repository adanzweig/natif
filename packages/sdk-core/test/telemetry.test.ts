import { describe, expect, it, vi } from "vitest";
import { deviceKey, sanitizeEvent, TelemetryQueue } from "../src";
import { highEndWeb } from "./helpers";

const good = {
  ts: 1, task: "daily-checkin", taskVersion: 3, runtime: "device", modelId: "qwen3-4b", deviceKey: "abcdef0123456789",
  platform: "web", latencyMs: 2000, tokensIn: 300, tokensOut: 40, outcome: "ok", sdkVersion: "0.1.0",
};

describe("telemetry whitelist", () => {
  it("accepts a valid event", () => expect(sanitizeEvent(good)).toEqual(good));

  it("drops fields that are not on the list (content never leaves)", () => {
    const e = sanitizeEvent({ ...good, input: "me siento mal", output: { mood: 2 }, userId: "u1", ip: "1.2.3.4" });
    expect(e).toEqual(good);
    expect(JSON.stringify(e)).not.toContain("me siento");
  });

  it("rejects free text smuggled into slug fields", () => {
    expect(sanitizeEvent({ ...good, task: "me siento muy triste hoy" })).toBeNull();
    expect(sanitizeEvent({ ...good, modelId: "x".repeat(200) })).toBeNull();
    expect(sanitizeEvent({ ...good, deviceKey: "John Smith" })).toBeNull();
  });

  it("does nothing without consent", async () => {
    const send = vi.fn();
    const q = new TelemetryQueue({ send }, { enabled: () => false });
    q.record(good);
    await q.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("batches", async () => {
    const send = vi.fn();
    const q = new TelemetryQueue({ send }, { enabled: () => true, batchSize: 2 });
    q.record(good);
    expect(send).not.toHaveBeenCalled();
    q.record(good);
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith([good, good]);
  });
});

describe("deviceKey", () => {
  it("is stable and coarse: small memory differences map to the same class", async () => {
    expect(await deviceKey(highEndWeb)).toBe(await deviceKey({ ...highEndWeb }));
    expect(await deviceKey({ ...highEndWeb, memoryGB: 7 })).toBe(await deviceKey({ ...highEndWeb, memoryGB: 8 }));
    expect(await deviceKey({ ...highEndWeb, memoryGB: 4 })).not.toBe(await deviceKey(highEndWeb));
  });
});
