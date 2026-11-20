import AsyncStorage from "@react-native-async-storage/async-storage";
import { createCoreClient, type ClientOptions, type NatifClient, type TelemetryTransport } from "@be-natif/core";
import { asyncStorageStore, detectNativeDevice, LlamaRNEngine, type LlamaModule, type LlamaRNEngineOptions, type ModelFiles } from "@be-natif/react-native/lib";
import * as Device from "expo-device";
import { Directory, DownloadTask, File, Paths } from "expo-file-system";
import { getBackendDevicesInfo, initLlama } from "llama.rn";
import { AppState, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { expoModelFiles, type ExpoFs } from "./files";
import { DEFAULT_IMAGE_MODEL, NativeImageEngine, type ImageModel, type ImageRequest, type ImageResult, type NativeImageModuleLike } from "./image";

export * from "@be-natif/core";
export { expoModelFiles, LlamaRNEngine, NativeImageEngine, DEFAULT_IMAGE_MODEL };
export type { ImageModel, ImageRequest, ImageResult };
export type { ExpoFs, ModelFiles, LlamaRNEngineOptions };

export const SDK_VERSION = "0.1.0";

export interface ExpoClientOptions extends ClientOptions {
  llama?: LlamaRNEngineOptions;
  /** Where models are stored. Default: <Documents>/natif-models via expo-file-system, resumable. */
  files?: ModelFiles;
  /** Your own reading of the RAM the app can use now, in MB (see @be-natif/react-native). */
  availableMemoryMB?: () => Promise<number | undefined>;
  /** Free the model when the app goes to the background (default true). */
  unloadOnBackground?: boolean;
  /** Image model for image() (default SD-Turbo q8, ~2 GB). Any stable-diffusion.cpp GGUF works. */
  imageModel?: ImageModel;
}

export interface ExpoNatifClient extends NatifClient {
  /**
   * Text → image on the device (stable-diffusion.cpp: Metal on iOS, CPU on Android). Returns a PNG
   * file URI. Only one large model is kept in memory: the text model is freed before generating and
   * the image model is freed before the next text call. First use downloads the model (resumable).
   */
  image(req: ImageRequest): Promise<ImageResult>;
  /** Downloads the image model without loading it (e.g. on Wi-Fi during onboarding). */
  downloadImageModel(opts?: { onProgress?: ImageRequest["onProgress"]; signal?: AbortSignal }): Promise<void>;
}

function fetchTransport(url: string, apiKey: string): TelemetryTransport {
  return {
    send: (events) =>
      fetch(url, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ apiKey, events }) }).then(() => {}),
  };
}

const onAppState = (cb: (state: string) => void) => {
  const sub = AppState.addEventListener("change", cb);
  return () => sub.remove();
};

/**
 * Same API as @be-natif/web and @be-natif/react-native. Requires a development build
 * (`npx expo run:ios` / EAS): llama.rn is native code, so it does not run in Expo Go.
 */
export function createClient(opts: ExpoClientOptions = {}): ExpoNatifClient {
  const files = opts.files ?? expoModelFiles({ File, Directory, Paths, DownloadTask } as unknown as ExpoFs, { onAppState });
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const client = createCoreClient(opts, {
    sdkVersion: SDK_VERSION,
    detectDevice: () =>
      detectNativeDevice({
        platform,
        osVersion: Device.osVersion ?? String(Platform.Version),
        hardwareModel: () => Device.modelId ?? Device.modelName ?? "unknown",
        totalMemoryBytes: async () => Device.totalMemory ?? 0,
        freeStorageBytes: () => files.freeBytes(),
        backendDevices: () => getBackendDevicesInfo(),
        availableMemoryMB: opts.availableMemoryMB,
      }),
    createTextEngine: () => new LlamaRNEngine({ initLlama } as unknown as LlamaModule, files, opts.llama),
    storage: asyncStorageStore(AsyncStorage),
    fetch: (...args) => fetch(...args),
    telemetryTransport: fetchTransport,
  });
  const images = new NativeImageEngine(
    requireOptionalNativeModule<NativeImageModuleLike>("NatifImage"),
    files,
    Paths.cache.uri.replace(/\/$/, ""),
    opts.imageModel,
  );
  // One large model in memory at a time: text calls free the image model first, and vice versa.
  const unloadText = client.unload.bind(client);
  const textCall = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    if (images.isLoaded) await images.unload();
    return fn(...a);
  };
  const ext = Object.assign(client, {
    chat: textCall(client.chat.bind(client)),
    extract: textCall(client.extract.bind(client)),
    extractWithMeta: textCall(client.extractWithMeta.bind(client)),
    classify: textCall(client.classify.bind(client)),
    async image(req: ImageRequest) {
      await unloadText();
      return images.generate(req);
    },
    async downloadImageModel(o: { onProgress?: ImageRequest["onProgress"]; signal?: AbortSignal } = {}) {
      await images.download(o.onProgress, o.signal);
    },
    async unload() {
      await images.unload();
      await unloadText();
    },
  }) as ExpoNatifClient;
  AppState.addEventListener("change", (state) => {
    if (state !== "background") return;
    void client.flushTelemetry();
    if (opts.unloadOnBackground !== false) void ext.unload();
  });
  return ext;
}
