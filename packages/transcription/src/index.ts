import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { Asset, TranscriptSegment, TranscriptionPort } from "@videocraft/domain";

export interface WhisperWorkerOptions {
  pythonCommand?: string;
  workerPath: string;
  mediaRoot: string;
  language?: string;
  timeoutMs?: number;
}

export class FasterWhisperWorker implements TranscriptionPort {
  private readonly options: Required<Omit<WhisperWorkerOptions, "language">> & Pick<WhisperWorkerOptions, "language">;

  constructor(options: WhisperWorkerOptions) {
    this.options = {
      pythonCommand: options.pythonCommand ?? "python",
      workerPath: options.workerPath,
      mediaRoot: resolve(options.mediaRoot),
      ...(options.language === undefined ? {} : { language: options.language }),
      timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
    };
  }

  async transcribe(asset: Asset): Promise<TranscriptSegment[]> {
    const assetPath = safeMediaPath(this.options.mediaRoot, asset.storageKey);
    const child = spawn(this.options.pythonCommand, [this.options.workerPath], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));

    const timer = setTimeout(() => child.kill("SIGTERM"), this.options.timeoutMs);
    child.stdin.end(JSON.stringify({
      assetPath,
      language: this.options.language,
      assetId: asset.id,
    }) + "\n");

    const [code] = await once(child, "close") as [number | null];
    clearTimeout(timer);
    if (code !== 0) throw new Error("Transcription worker failed: " + Buffer.concat(errors).toString().slice(-4000));
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(output).toString()); }
    catch { throw new Error("Transcription worker returned invalid JSON"); }
    return parseSegments(parsed, asset.id);
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
