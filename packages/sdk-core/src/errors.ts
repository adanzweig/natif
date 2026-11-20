import type { FallbackReason } from "./types";

export class NatifError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The device can't run the task and the cloud is not allowed (no consent or device-only project). */
export class DeviceUnavailableError extends NatifError {
  constructor(
    readonly reason: FallbackReason,
    detail?: string,
  ) {
    super(`On-device inference unavailable (${reason})${detail ? `: ${detail}` : ""}`);
  }
}

/** The model output didn't match the schema, even after one repair attempt. */
export class SchemaValidationError extends NatifError {
  constructor(
    readonly issues: unknown,
    readonly raw: string,
  ) {
    super("Model output does not match the schema");
  }
}

export class CloudFallbackError extends NatifError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Cloud fallback failed (${status}): ${message}`);
  }
}

export class TaskNotFoundError extends NatifError {
  constructor(readonly task: string) {
    super(`Task "${task}" not found or not published`);
  }
}
