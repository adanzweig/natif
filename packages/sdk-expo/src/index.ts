import AsyncStorage from "@react-native-async-storage/async-storage";
import { createCoreClient, type ClientOptions, type NatifClient, type TelemetryTransport } from "@be-natif/core";
import { asyncStorageStore, detectNativeDevice, LlamaRNEngine, type LlamaModule, type LlamaRNEngineOptions, type ModelFiles } from "@be-natif/react-native/lib";
import * as Device from "expo-device";
import { Directory, DownloadTask, File, Paths } from "expo-file-system";
import { getBackendDevicesInfo, initLlama } from "llama.rn";
import { AppState, Platform } from "react-native";
import { expoModelFiles, type ExpoFs } from "./files";

export * from "@be-natif/core";
export { expoModelFiles, LlamaRNEngine };
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
export function createClient(opts: ExpoClientOptions = {}): NatifClient {
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
  AppState.addEventListener("change", (state) => {
    if (state !== "background") return;
    void client.flushTelemetry();
    if (opts.unloadOnBackground !== false) void client.unload();
  });
  return client;
}
