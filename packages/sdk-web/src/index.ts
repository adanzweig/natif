import { createCoreClient, type ClientOptions, type NatifClient, type TelemetryTransport } from "@be-natif/core";
import { detectWebDevice } from "./device";
import { createStore } from "./idb-store";
import { ImageEngine, IMAGE_MODEL_ID, type ImageRequest, type ImageResult } from "./image";
import { WebLLMEngine, type WebLLMEngineOptions } from "./webllm-engine";

export * from "@be-natif/core";
export { WebLLMEngine, detectWebDevice, ImageEngine, IMAGE_MODEL_ID };
export type { ImageRequest, ImageResult };
export { parseBrowser, parseOs } from "./device";

export const SDK_VERSION = "0.1.0";

export interface WebClientOptions extends ClientOptions {
  webllm?: WebLLMEngineOptions;
  /** Override how the image worker is created (bundlers that need an explicit worker import). */
  createImageWorker?: () => Worker;
}

export interface WebNatifClient extends NatifClient {
  /**
   * Text → image on the device (Janus-Pro-1B on WebGPU, 384×384 PNG). By default the text model
   * is unloaded first so only one large model is in memory; pass `keepTextModel: true` to skip that.
   */
  image(req: ImageRequest & { keepTextModel?: boolean }): Promise<ImageResult>;
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

export function createClient(opts: WebClientOptions = {}): WebNatifClient {
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
  const images = new ImageEngine(opts.createImageWorker);
  const unloadText = client.unload.bind(client);
  return Object.assign(client, {
    async image(req: ImageRequest & { keepTextModel?: boolean }) {
      if (!req.keepTextModel) await unloadText();
      return images.generate(req);
    },
    /** Frees every model this client loaded (text and image). Weights stay cached. */
    async unload() {
      images.unload();
      await unloadText();
    },
  });
}
