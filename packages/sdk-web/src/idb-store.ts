import { MemoryStore, type KeyValueStore } from "@be-natif/core";

/** Tiny IndexedDB key-value store for benchmarks and task configs (weights live in the Cache API). */
export class IdbStore implements KeyValueStore {
  private db: Promise<IDBDatabase>;

  constructor(name = "benatif") {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const r = fn(db.transaction("kv", mode).objectStore("kv"));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => reject(r.error);
    });
  }

  get<T>(key: string) {
    return this.tx<T | undefined>("readonly", (s) => s.get(key));
  }
  async set<T>(key: string, value: T) {
    await this.tx("readwrite", (s) => s.put(value, key));
  }
  async delete(key: string) {
    await this.tx("readwrite", (s) => s.delete(key));
  }
  async clear() {
    await this.tx("readwrite", (s) => s.clear());
  }
}

/** IndexedDB can be missing (some private modes); fall back to memory. */
export function createStore(): KeyValueStore {
  try {
    if (typeof indexedDB !== "undefined") return new IdbStore();
  } catch {
    // fall through
  }
  return new MemoryStore();
}
