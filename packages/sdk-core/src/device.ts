import { sha256Hex } from "./sha256";
import type { DeviceProfile } from "./types";

const pow2Bucket = (n: number) => 2 ** Math.round(Math.log2(Math.max(n, 1)));

/**
 * Traits that describe the *class* of device. Buckets keep it coarse so it can't
 * fingerprint an individual; aggregates are only used once n ≥ 20 per key.
 */
export function deviceClassTraits(d: DeviceProfile): Record<string, string | number | boolean> {
  return {
    platform: d.platform,
    browser: d.browser ? `${d.browser.name}/${d.browser.major}` : "",
    os: d.os ?? "",
    hw: d.hardwareModel ?? "",
    gpu: d.gpu.available,
    gpuVendor: d.gpu.vendor ?? "",
    gpuArch: d.gpu.architecture ?? "",
    f16: d.gpu.shaderF16 ?? false,
    maxBufGB: d.gpu.maxBufferSize ? pow2Bucket(d.gpu.maxBufferSize / 2 ** 30) : 0,
    memGB: d.memoryGB ? pow2Bucket(d.memoryGB) : 0,
  };
}

export async function deviceKey(d: DeviceProfile): Promise<string> {
  const traits = deviceClassTraits(d);
  const canonical = Object.keys(traits)
    .sort()
    .map((k) => `${k}=${traits[k]}`)
    .join("|");
  return (await sha256Hex(canonical)).slice(0, 24);
}
