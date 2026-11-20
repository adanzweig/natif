/** Where GGUF model files live on the phone. Injectable so it can be tested or swapped (e.g. expo-file-system). */
export interface ModelFiles {
  /** Absolute directory for model files (inside the app sandbox). */
  dir: string;
  exists(path: string): Promise<boolean>;
  freeBytes(): Promise<number | undefined>;
  ensureDir(path: string): Promise<void>;
  /** Downloads to `dest`, calling onProgress with 0..1. */
  download(url: string, dest: string, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<void>;
  /** True when `download` continues a partial `dest` instead of starting over (keep the .part file). */
  resumes?: boolean;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

type Rnfs = typeof import("@dr.pogodin/react-native-fs");

/** Default implementation on @dr.pogodin/react-native-fs. */
export function rnfsModelFiles(fs: Rnfs, dir = `${fs.DocumentDirectoryPath}/natif-models`): ModelFiles {
  return {
    dir,
    exists: (p) => fs.exists(p),
    freeBytes: async () => {
      try {
        return (await fs.getFSInfo()).freeSpace;
      } catch {
        return undefined;
      }
    },
    ensureDir: (p) => fs.mkdir(p),
    async download(url, dest, onProgress) {
      const job = fs.downloadFile({
        fromUrl: url,
        toFile: dest,
        progressInterval: 250,
        // Big files: keep going if the user switches apps for a moment (iOS).
        background: true,
        progress: (r) => onProgress?.(r.contentLength > 0 ? r.bytesWritten / r.contentLength : 0),
      });
      const res = await job.promise;
      if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Model download failed (HTTP ${res.statusCode})`);
    },
    move: (a, b) => fs.moveFile(a, b),
    remove: async (p) => {
      if (await fs.exists(p)) await fs.unlink(p);
    },
  };
}
