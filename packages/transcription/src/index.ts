import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import type { Asset, TranscriptSegment, TranscriptionPort } from "@videocraft/domain";
import type { ObjectStorage } from "@videocraft/storage";

export interface WhisperWorkerOptions {
  pythonCommand?: string;
  workerPath: string;
  mediaRoot?: string;
  storage?: ObjectStorage;
  language?: string;
  timeoutMs?: number;
}

export class FasterWhisperWorker implements TranscriptionPort {
  private readonly options: {
    pythonCommand: string;
    workerPath: string;
    mediaRoot?: string;
    storage?: ObjectStorage;
    language?: string;
    timeoutMs: number;
  };

  constructor(options: WhisperWorkerOptions) {
    if (!options.mediaRoot && !options.storage) throw new Error("A mediaRoot or storage adapter is required");
    this.options = {
      pythonCommand: options.pythonCommand ?? "python",
      workerPath: options.workerPath,
      ...(options.mediaRoot ? { mediaRoot: resolve(options.mediaRoot) } : {}),
      ...(options.storage ? { storage: options.storage } : {}),
      ...(options.language === undefined ? {} : { language: options.language }),
      timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
    };
  }

  async transcribe(asset: Asset): Promise<TranscriptSegment[]> {
    const stagingDirectory = this.options.storage ? await mkdtemp(join(tmpdir(), "videocraft-transcription-")) : undefined;
    try {
      let assetPath: string;
      if (stagingDirectory) {
        if (!this.options.storage?.downloadToFile) throw new Error("Configured storage provider cannot stage media for transcription");
        assetPath = join(stagingDirectory, "input.media");
        await this.options.storage.downloadToFile(asset.storageKey, assetPath);
      } else {
        assetPath = safeMediaPath(this.options.mediaRoot!, asset.storageKey);
      }

      const child = spawn(this.options.pythonCommand, [this.options.workerPath], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));

      // stdin is a separate stream: an early worker exit can emit EPIPE here,
      // not on the child process. Consume it and reject the operation after close.
      let inputError: Error | undefined;
      child.stdin.on("error", (error: Error) => { inputError = error; });

      const timer = setTimeout(() => child.kill("SIGTERM"), this.options.timeoutMs);
      let code: number | null;
      try {
        const closed = once(child, "close");
        child.stdin.end(JSON.stringify({
          assetPath,
          language: this.options.language,
          assetId: asset.id,
        }) + "\n");
        [code] = await closed as [number | null];
      } finally { clearTimeout(timer); }
      if (code !== 0 || inputError) throw new Error("Transcription worker failed: " + (Buffer.concat(errors).toString().slice(-4000) || inputError?.message || "worker exited without a result"));
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(output).toString()); }
      catch { throw new Error("Transcription worker returned invalid JSON"); }
      return parseSegments(parsed, asset.id);
    } finally {
      if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function safeMediaPath(mediaRoot: string, storageKey: string): string {
  if (!storageKey || isAbsolute(storageKey) || /^[A-Za-z]:[\\/]/.test(storageKey) || storageKey.includes("\0")) throw new Error("Invalid media storage key");
  const root = resolve(mediaRoot);
  const candidate = resolve(root, storageKey);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("Media path escapes configured root");
  return candidate;
}

function parseSegments(value: unknown, assetId: string): TranscriptSegment[] {
  if (!isObject(value) || !Array.isArray(value.segments)) throw new Error("Invalid transcription response");
  return value.segments.map((segment, index) => {
    if (!isObject(segment) || typeof segment.startUs !== "number" || typeof segment.endUs !== "number" || typeof segment.text !== "string") {
      throw new Error("Invalid transcription segment at index " + index);
    }
    return {
      id: typeof segment.id === "string" ? segment.id : assetId + "-segment-" + index,
      assetId,
      startUs: segment.startUs,
      endUs: segment.endUs,
      text: segment.text,
      words: Array.isArray(segment.words) ? segment.words.filter(isWord) : [],
      provider: "faster-whisper",
      ...(typeof segment.providerVersion === "string" ? { providerVersion: segment.providerVersion } : {}),
    };
  });
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isWord(value: unknown): value is TranscriptSegment["words"][number] {
  return isObject(value) && typeof value.text === "string" && typeof value.startUs === "number" && typeof value.endUs === "number";
}
