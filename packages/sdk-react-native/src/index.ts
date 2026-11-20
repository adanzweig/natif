import AsyncStorage from "@react-native-async-storage/async-storage";
import * as RNFS from "@dr.pogodin/react-native-fs";
import { createCoreClient, type ClientOptions, type NatifClient, type TelemetryTransport } from "@be-natif/core";
import { getBackendDevicesInfo, initLlama } from "llama.rn";
import { AppState, Platform } from "react-native";
import DeviceInfo from "react-native-device-info";
import { detectNativeDevice } from "./device";
import { LlamaRNEngine, type LlamaModule, type LlamaRNEngineOptions } from "./engine";
import { rnfsModelFiles, type ModelFiles } from "./files";
import { asyncStorageStore } from "./storage";

export * from "@be-natif/core";
export { LlamaRNEngine, detectNativeDevice, rnfsModelFiles, asyncStorageStore };
export type { ModelFiles, LlamaRNEngineOptions, LlamaModule };
export type { NativeDeviceSources } from "./device";

export const SDK_VERSION = "0.1.0";

export interface NativeClientOptions extends ClientOptions {
  llama?: LlamaRNEngineOptions;
  /** Where models are stored. Default: <Documents>/natif-models via react-native-fs. */
  files?: ModelFiles;
  /**
   * Your own reading of the RAM the app can use right now, in MB (iOS os_proc_available_memory,
   * Android ActivityManager availMem). The best signal for picking a model that won't get the app killed.
   */
  availableMemoryMB?: () => Promise<number | undefined>;
  /**
   * Free the model when the app goes to the background (default true). iOS kills background apps
   * that hold a lot of memory; the model reloads from disk in a few seconds on the next call.
   */
  unloadOnBackground?: boolean;
}

function fetchTransport(url: string, apiKey: string): TelemetryTransport {
  return {
    send: (events) =>
      fetch(url, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ apiKey, events }) }).then(() => {}),
  };
}

export function createClient(opts: NativeClientOptions = {}): NatifClient {
  const files = opts.files ?? rnfsModelFiles(RNFS);
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const client = createCoreClient(opts, {
    sdkVersion: SDK_VERSION,
    detectDevice: () =>
      detectNativeDevice({
        platform,
        osVersion: String(Platform.Version),
        hardwareModel: () => DeviceInfo.getDeviceId(),
        totalMemoryBytes: () => DeviceInfo.getTotalMemory(),
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
