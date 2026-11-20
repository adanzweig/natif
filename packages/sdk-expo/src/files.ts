import type { ModelFiles } from "@be-natif/react-native/lib";

/** The slice of expo-file-system (SDK 54+ object API) this module uses; injected so tests don't need a phone. */
export interface ExpoFs {
  File: {
    new (...uris: (string | { uri: string })[]): ExpoFile;
    createDownloadTask(url: string, destination: ExpoFile, options?: { onProgress?: (p: { bytesWritten: number; totalBytes: number }) => void }): ExpoDownloadTask;
  };
  Directory: new (...uris: (string | { uri: string })[]) => { uri: string; exists: boolean; create(o?: { intermediates?: boolean; idempotent?: boolean }): void };
  Paths: { document: { uri: string }; availableDiskSpace: number };
  DownloadTask: { fromSavable(state: unknown, options?: { onProgress?: (p: { bytesWritten: number; totalBytes: number }) => void }): ExpoDownloadTask };
}
interface ExpoFile {
  uri: string;
  exists: boolean;
  delete(): void;
  move(to: ExpoFile | { uri: string }): void;
  write(content: string): void;
  textSync(): string;
}
interface ExpoDownloadTask {
  downloadAsync(): Promise<unknown>;
  pauseAsync(): Promise<void>;
  resumeAsync(): Promise<unknown>;
  cancel(): void;
  savable(): unknown;
}

/**
 * Model storage on expo-file-system. Downloads are resumable: when the app goes to the background
 * or the download is aborted, the task is paused and its state saved next to the file, so the next
 * attempt (even after the app was killed) continues instead of starting over.
 */
export function expoModelFiles(fs: ExpoFs, opts: { onAppState?: (cb: (state: string) => void) => () => void } = {}): ModelFiles {
  const dir = new fs.Directory(fs.Paths.document, "natif-models");
  const file = (p: string) => new fs.File(p);
  const sidecar = (dest: string) => file(`${dest}.resume.json`);

  return {
    dir: dir.uri.replace(/\/$/, ""),
    resumes: true,
    exists: async (p) => file(p).exists,
    freeBytes: async () => {
      try {
        return fs.Paths.availableDiskSpace;
      } catch {
        return undefined;
      }
    },
    ensureDir: async (p) => new fs.Directory(p).create({ intermediates: true, idempotent: true }),
    async download(url, dest, onProgress, signal) {
      const progress = { onProgress: (p: { bytesWritten: number; totalBytes: number }) => onProgress?.(p.totalBytes > 0 ? p.bytesWritten / p.totalBytes : 0) };
      const side = sidecar(dest);
      let task: ExpoDownloadTask | undefined;
      if (side.exists) {
        try {
          task = fs.DownloadTask.fromSavable(JSON.parse(side.textSync()), progress);
        } catch {
          side.delete(); // stale or unreadable state: start over
        }
      }
      const resuming = !!task;
      task ??= fs.File.createDownloadTask(url, file(dest), progress);

      const save = async () => {
        try {
          await task!.pauseAsync();
          side.write(JSON.stringify(task!.savable()));
        } catch {
          /* nothing to save yet */
        }
      };
      const onAbort = () => void save();
      signal?.addEventListener("abort", onAbort, { once: true });
      const stopWatching = opts.onAppState?.((state) => {
        if (state === "background") void save();
        else if (state === "active") void task!.resumeAsync().catch(() => {});
      });
      try {
        const out = resuming ? await task.resumeAsync() : await task.downloadAsync();
        if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
        if (out == null) throw new Error("Model download paused");
        if (side.exists) side.delete();
      } finally {
        signal?.removeEventListener("abort", onAbort);
        stopWatching?.();
      }
    },
    move: async (a, b) => file(a).move(file(b)),
    remove: async (p) => {
      const f = file(p);
      if (f.exists) f.delete();
      const s = sidecar(p);
      if (s.exists) s.delete();
    },
  };
}
