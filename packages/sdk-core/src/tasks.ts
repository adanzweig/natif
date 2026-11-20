import { TaskNotFoundError } from "./errors";
import type { DeviceRecommendation } from "./selection";
import type { KeyValueStore, TaskConfig } from "./types";

export const TASK_DEFAULTS = {
  version: 0,
  inputType: "text",
  temperature: 0,
  maxTokens: 256,
  minDeviceTokPerSec: 8,
} as const satisfies Partial<TaskConfig>;

export type LocalTask = Partial<TaskConfig> & { systemPrompt: string };

export interface TaskBundle {
  task: TaskConfig;
  recommendation?: DeviceRecommendation;
}

interface CachedTask {
  etag?: string;
  bundle: TaskBundle;
}

export function completeTask(slug: string, t: LocalTask): TaskConfig {
  return { ...TASK_DEFAULTS, ...t, slug };
}

/**
 * Loads published task configs from the backend, with an ETag cache so the app keeps working
 * offline with the last version it saw. Local tasks (passed to createClient) skip the network.
 */
export class TaskStore {
  private memo = new Map<string, Promise<TaskBundle>>();

  constructor(
    private opts: {
      local?: Record<string, LocalTask>;
      baseUrl?: string;
      apiKey?: string;
      storage: KeyValueStore;
      fetch: typeof fetch;
      deviceKey: () => Promise<string>;
    },
  ) {}

  get(slug: string): Promise<TaskBundle> {
    let p = this.memo.get(slug);
    if (!p) {
      p = this.load(slug).catch((e) => {
        this.memo.delete(slug);
        throw e;
      });
      this.memo.set(slug, p);
    }
    return p;
  }

  private async load(slug: string): Promise<TaskBundle> {
    const local = this.opts.local?.[slug];
    if (local) return { task: completeTask(slug, local) };
    if (!this.opts.baseUrl || !this.opts.apiKey) throw new TaskNotFoundError(slug);

    const cacheKey = `task:${slug}`;
    const cached = await this.opts.storage.get<CachedTask>(cacheKey);
    const url = `${this.opts.baseUrl}/v1/tasks/${encodeURIComponent(slug)}?deviceKey=${await this.opts.deviceKey()}`;
    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        headers: { "x-api-key": this.opts.apiKey, ...(cached?.etag ? { "if-none-match": cached.etag } : {}) },
      });
    } catch (e) {
      if (cached) return cached.bundle; // offline
      throw e;
    }
    if (res.status === 304 && cached) return cached.bundle;
    if (res.status === 404) throw new TaskNotFoundError(slug);
    if (!res.ok) {
      if (cached) return cached.bundle;
      throw new Error(`Task fetch failed: ${res.status}`);
    }
    const body = (await res.json()) as { task: LocalTask & { slug: string }; recommendation?: DeviceRecommendation };
    const bundle: TaskBundle = { task: completeTask(slug, body.task), recommendation: body.recommendation };
    await this.opts.storage.set<CachedTask>(cacheKey, { etag: res.headers.get("etag") ?? undefined, bundle });
    return bundle;
  }
}
