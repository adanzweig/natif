import { createCoreClient, type ClientOptions, type NatifClient, type TelemetryTransport } from "@be-natif/core";
import { detectWebDevice } from "./device";
import { createStore } from "./idb-store";
import { WebLLMEngine, type WebLLMEngineOptions } from "./webllm-engine";

export * from "@be-natif/core";
export { WebLLMEngine, detectWebDevice };
export { parseBrowser, parseOs } from "./device";

export const SDK_VERSION = "0.1.0";

export interface WebClientOptions extends ClientOptions {
  webllm?: WebLLMEngineOptions;
}

/** Telemetry survives page close: sendBeacon with a CORS-safe content type, fetch keepalive otherwise. */
function beaconTransport(url: string, apiKey: string): TelemetryTransport {
  return {
    send(events) {
      const body = JSON.stringify({ apiKey, events });
      const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
      if (navigator.sendBeacon?.(url, blob)) return;
      return fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain;charset=UTF-8" } }).then(() => {});
    },
  };
}

export function createClient(opts: WebClientOptions = {}): NatifClient {
  const client = createCoreClient(opts, {
    sdkVersion: SDK_VERSION,
    detectDevice: detectWebDevice,
    createTextEngine: () => new WebLLMEngine(opts.webllm),
    storage: createStore(),
    fetch: (...args) => fetch(...args),
    telemetryTransport: beaconTransport,
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void client.flushTelemetry();
    });
  }
  return client;
}
