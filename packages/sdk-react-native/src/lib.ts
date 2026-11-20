// Platform-neutral pieces (no native imports), shared with @be-natif/expo and usable for custom setups.
export { LlamaRNEngine, type LlamaModule, type LlamaContextLike, type LlamaRNEngineOptions } from "./engine";
export { detectNativeDevice, type NativeDeviceSources } from "./device";
export { asyncStorageStore } from "./storage";
export type { ModelFiles } from "./files";
