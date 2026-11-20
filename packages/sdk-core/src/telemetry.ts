import { z } from "zod";
import type { FallbackReason } from "./types";

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i);

/**
 * Whitelist of what may leave the device. Every string is an enum or a short slug, so free
 * text (user input, model output, names) can't slip through. Unknown keys are dropped.
 */
export const TelemetryEventSchema = z
  .object({
    ts: z.number().int(),
    task: slug,
    taskVersion: z.number().int().nonnegative(),
    runtime: z.enum(["device", "cloud", "none"]),
    modelId: slug,
    deviceKey: z.string().regex(/^[0-9a-f]{8,64}$/),
    platform: z.enum(["web", "ios", "android", "node"]),
    latencyMs: z.number().nonnegative(),
    loadMs: z.number().nonnegative().optional(),
    decodeTokPerSec: z.number().nonnegative().optional(),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    outcome: z.enum(["ok", "schema_error", "engine_error", "timeout", "unavailable"]),
    fallbackReason: z
      .enum([
        "no_webgpu",
        "insufficient_memory",
        "insufficient_storage",
        "no_model_for_capability",
        "known_slow_device",
        "benchmark_slow",
        "load_failed",
        "engine_error",
        "schema_failed_after_repair",
        "timeout",
        "forced_cloud",
      ] satisfies [FallbackReason, ...FallbackReason[]])
      .optional(),
    repaired: z.boolean().optional(),
    sdkVersion: z.string().regex(/^\d+\.\d+\.\d+([-.][0-9a-z.]+)?$/i),
  })
  .strip();

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/** Returns the sanitized event, or null if it doesn't pass the whitelist. */
export function sanitizeEvent(e: unknown): TelemetryEvent | null {
  const r = TelemetryEventSchema.safeParse(e);
  return r.success ? r.data : null;
}

export interface TelemetryTransport {
  send(events: TelemetryEvent[]): void | Promise<void>;
}

export class TelemetryQueue {
  private buffer: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private transport: TelemetryTransport,
    private opts: { enabled: () => boolean; batchSize?: number; flushMs?: number } = { enabled: () => true },
  ) {}

  record(e: unknown): void {
    if (!this.opts.enabled()) return;
    const clean = sanitizeEvent(e);
    if (!clean) return;
    this.buffer.push(clean);
    if (this.buffer.length >= (this.opts.batchSize ?? 20)) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.opts.flushMs ?? 10_000);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.buffer.length) return;
    const batch = this.buffer.splice(0);
    try {
      await this.transport.send(batch);
    } catch {
      // Telemetry is best effort; never break the app for it.
    }
  }
}
