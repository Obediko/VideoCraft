import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSilence, type SilenceSpan } from "@videocraft/analysis";
import type { ObjectStorage } from "@videocraft/storage";

/** Finds silent spans in a stored media object using FFmpeg's silencedetect. */
export class StorageSilenceDetector {
  constructor(private readonly storage: ObjectStorage, private readonly options: { ffmpeg?: string; timeoutMs?: number } = {}) {}

  async detect(storageKey: string): Promise<SilenceSpan[]> {
    const directory = this.storage.downloadToFile ? await mkdtemp(join(tmpdir(), "videocraft-silence-")) : undefined;
    const inputPath = directory ? join(directory, "input.media") : this.storage.resolve(storageKey);
    try {
      if (directory) await this.storage.downloadToFile!(storageKey, inputPath);
      return await detectSilence(inputPath, { ...(this.options.ffmpeg ? { executable: this.options.ffmpeg } : {}), timeoutMs: this.options.timeoutMs ?? 5 * 60_000 });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
