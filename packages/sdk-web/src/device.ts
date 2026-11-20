import type { DeviceProfile } from "@be-natif/core";

export function parseBrowser(ua: string): { name: string; major: number } | undefined {
  const rules: [string, RegExp][] = [
    ["edge", /Edg\/(\d+)/],
    ["firefox", /Firefox\/(\d+)/],
    ["chrome", /Chrome\/(\d+)/],
    ["safari", /Version\/(\d+).*Safari/],
  ];
  for (const [name, re] of rules) {
    const m = ua.match(re);
    if (m) return { name, major: Number(m[1]) };
  }
  return undefined;
}

export function parseOs(ua: string): string | undefined {
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac OS X/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua)) return "linux";
  return undefined;
}

export async function detectWebDevice(): Promise<DeviceProfile> {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; saveData?: boolean };
    gpu?: { requestAdapter(o?: object): Promise<any> };
  };
  const profile: DeviceProfile = {
    platform: "web",
    browser: parseBrowser(nav.userAgent),
    os: parseOs(nav.userAgent),
    gpu: { available: false },
    memoryGB: nav.deviceMemory,
    connection: nav.connection ? { effectiveType: nav.connection.effectiveType, saveData: nav.connection.saveData } : undefined,
  };
  try {
    const est = await nav.storage?.estimate?.();
    if (est?.quota !== undefined) profile.storageFreeBytes = est.quota - (est.usage ?? 0);
  } catch {
    // ignore
  }
  try {
    const adapter = await nav.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (adapter) {
      profile.gpu = {
        available: true,
        vendor: adapter.info?.vendor || undefined,
        architecture: adapter.info?.architecture || undefined,
        shaderF16: adapter.features.has("shader-f16"),
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      };
    }
  } catch {
    // WebGPU present but unusable (blocklisted driver, disabled acceleration...)
  }
  return profile;
}
