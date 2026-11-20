import type { DeviceProfile } from "@be-natif/core";

export interface NativeDeviceSources {
  platform: "ios" | "android";
  osVersion: string;
  /** e.g. "iPhone16,2" */
  hardwareModel(): Promise<string> | string;
  totalMemoryBytes(): Promise<number>;
  freeStorageBytes(): Promise<number | undefined>;
  /** llama.rn backend devices (GPU entries report the memory the GPU may use). */
  backendDevices?(): Promise<Array<{ type: string; deviceName: string; maxMemorySize: number }>>;
  /** App-provided reading of the RAM it can use now (iOS os_proc_available_memory, Android availMem). */
  availableMemoryMB?(): Promise<number | undefined>;
}

/**
 * Builds the device profile from what the phone reports. Memory the app can use comes, in order,
 * from the app's own reading, the GPU working-set limit reported by Metal/Vulkan, or nothing (then
 * sdk-core budgets on total RAM with a safe cap).
 */
export async function detectNativeDevice(src: NativeDeviceSources): Promise<DeviceProfile> {
  const [hardwareModel, total, free, backends, available] = await Promise.all([
    Promise.resolve(src.hardwareModel()).catch(() => undefined),
    src.totalMemoryBytes().catch(() => undefined),
    src.freeStorageBytes().catch(() => undefined),
    src.backendDevices?.().catch(() => []) ?? Promise.resolve([]),
    src.availableMemoryMB?.().catch(() => undefined) ?? Promise.resolve(undefined),
  ]);
  const gpu = backends.find((b) => /gpu|metal|vulkan|opencl/i.test(`${b.type} ${b.deviceName}`));
  const gpuMB = gpu?.maxMemorySize ? gpu.maxMemorySize / 2 ** 20 : undefined;
  return {
    platform: src.platform,
    os: `${src.platform} ${src.osVersion}`,
    hardwareModel,
    gpu: { available: !!gpu, vendor: gpu?.deviceName },
    memoryGB: total ? Math.round(total / 2 ** 30) : undefined,
    availableMemoryMB: available ?? gpuMB,
    storageFreeBytes: free,
  };
}
