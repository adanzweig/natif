import type { KeyValueStore } from "@be-natif/core";

type AsyncStorageLike = {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiRemove?(keys: string[]): Promise<void>;
};

/** KeyValueStore on AsyncStorage, namespaced so clear() only touches benatif keys. */
export function asyncStorageStore(storage: AsyncStorageLike, prefix = "benatif:"): KeyValueStore {
  return {
    async get<T>(key: string) {
      const v = await storage.getItem(prefix + key);
      return v == null ? undefined : (JSON.parse(v) as T);
    },
    set: (key, value) => storage.setItem(prefix + key, JSON.stringify(value)),
    delete: (key) => storage.removeItem(prefix + key),
    async clear() {
      const keys = (await storage.getAllKeys()).filter((k) => k.startsWith(prefix));
      if (storage.multiRemove) await storage.multiRemove(keys);
      else await Promise.all(keys.map((k) => storage.removeItem(k)));
    },
  };
}
