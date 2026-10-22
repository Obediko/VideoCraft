import { spawn } from "node:child_process";
import type { Microseconds, TranscriptWord } from "@videocraft/domain";

export interface MediaInfo {
  durationUs: Microseconds;
  formatName: string;
  sizeBytes: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  rotation?: number;
}

export interface MediaLimits { maxDurationUs: Microseconds; maxWidth: number; maxHeight: number; maxSizeBytes: number; requireAudio: boolean; }
export const DEFAULT_MEDIA_LIMITS: MediaLimits = { maxDurationUs: 4 * 3600 * 1_000_000, maxWidth: 7680, maxHeight: 4320, maxSizeBytes: 20 * 1024 ** 3, requireAudio: false };

export interface SilenceSpan { startUs: Microseconds; endUs: Microseconds; }
export interface SpeechSpan { startUs: Microseconds; endUs: Microseconds; }

export interface ToolOptions { executable?: string; signal?: AbortSignal; timeoutMs?: number; }

function run(executable: string, args: string[], options: ToolOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const limit = 8 * 1024 * 1024;
    child.stdout.on("data", (chunk) => { if (stdout.length < limit) stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.length < limit) stderr += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 10 * 60_000);
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (code !== 0) return reject(new Error(executable + " exited with code " + code + ": " + stderr.slice(-1000)));
      resolve({ stdout, stderr });
    });
  });
}

/** Extracts duration, streams and container metadata with ffprobe. */
export async function probeMedia(path: string, options: ToolOptions = {}): Promise<MediaInfo> {
  if (!path || path.includes("\0")) throw new Error("Media path is required");
  const { stdout } = await run(options.executable ?? "ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", path], options);
  return parseProbe(stdout);
}

export function parseProbe(json: string): MediaInfo {
  let data: any;
  try { data = JSON.parse(json); } catch { throw new Error("ffprobe returned invalid JSON"); }
  const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const seconds = Number(data?.format?.duration ?? video?.duration ?? audio?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Could not determine media duration");
  const frameRate = parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate);
  const rotation = Number(video?.side_data_list?.find((entry: any) => entry.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  const swapped = Math.abs(rotation) % 180 === 90;
  const width = video ? Number(swapped ? video.height : video.width) : undefined;
  const height = video ? Number(swapped ? video.width : video.height) : undefined;
  return {
    durationUs: Math.round(seconds * 1_000_000),
    formatName: String(data?.format?.format_name ?? "unknown"),
    sizeBytes: Number(data?.format?.size ?? 0),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    ...(width && height ? { width, height } : {}),
    ...(frameRate ? { frameRate } : {}),
    ...(video?.codec_name ? { videoCodec: String(video.codec_name) } : {}),
    ...(audio?.codec_name ? { audioCodec: String(audio.codec_name) } : {}),
    ...(rotation ? { rotation } : {}),
  };
}

function parseRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return undefined;
  const rate = num / den;
  return Number.isFinite(rate) && rate > 0 && rate <= 240 ? Math.round(rate * 1000) / 1000 : undefined;
}

/** Throws a user-presentable error when an upload cannot be edited. */
export function validateMedia(info: MediaInfo, limits: MediaLimits = DEFAULT_MEDIA_LIMITS): void {
  if (!info.hasVideo && !info.hasAudio) throw new Error("File contains no audio or video stream");
  if (info.durationUs > limits.maxDurationUs) throw new Error("Media is longer than the supported maximum duration");
  if (info.sizeBytes > limits.maxSizeBytes) throw new Error("Media file is larger than the supported maximum size");
  if (info.width && info.height && (info.width > limits.maxWidth || info.height > limits.maxHeight)) throw new Error("Video resolution exceeds the supported maximum");
  if (limits.requireAudio && !info.hasAudio) throw new Error("Media has no audio track to transcribe");
}

export interface SilenceOptions extends ToolOptions { noiseDb?: number; minDurationUs?: Microseconds; }

/** Detects silent spans with FFmpeg's silencedetect filter. */
export async function detectSilence(path: string, options: SilenceOptions = {}): Promise<SilenceSpan[]> {
  const noise = options.noiseDb ?? -32;
  const minSeconds = (options.minDurationUs ?? 450_000) / 1_000_000;
  if (!(noise < 0 && noise >= -90)) throw new Error("noiseDb must be between -90 and 0");
  if (!(minSeconds >= 0.05 && minSeconds <= 60)) throw new Error("minDurationUs must be between 0.05s and 60s");
  const { stderr } = await run(options.executable ?? "ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-vn", "-af", "silencedetect=noise=" + noise + "dB:d=" + minSeconds, "-f", "null", "-"], options);
  return parseSilenceDetect(stderr);
}

export function parseSilenceDetect(output: string, durationUs?: Microseconds): SilenceSpan[] {
  const spans: SilenceSpan[] = [];
  let open: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start?.[1] !== undefined) { open = Math.max(0, Math.round(Number(start[1]) * 1_000_000)); continue; }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (end?.[1] !== undefined && open !== undefined) {
      const endUs = Math.round(Number(end[1]) * 1_000_000);
      if (endUs > open) spans.push({ startUs: open, endUs });
      open = undefined;
    }
  }
  if (open !== undefined && durationUs !== undefined && durationUs > open) spans.push({ startUs: open, endUs: durationUs });
  return spans;
}

/** Complement of the silences: where somebody is actually speaking. */
export function speechSpans(durationUs: Microseconds, silences: SilenceSpan[], options: { paddingUs?: Microseconds; minSpeechUs?: Microseconds } = {}): SpeechSpan[] {
  const padding = options.paddingUs ?? 120_000;
  const minSpeech = options.minSpeechUs ?? 200_000;
  const merged = mergeSpans(silences.map((span) => ({ startUs: Math.max(0, span.startUs), endUs: Math.min(durationUs, span.endUs) })).filter((span) => span.endUs > span.startUs));
  const speech: SpeechSpan[] = [];
  let cursor = 0;
  for (const silence of merged) {
    if (silence.startUs > cursor) speech.push({ startUs: cursor, endUs: silence.startUs });
    cursor = silence.endUs;
  }
  if (cursor < durationUs) speech.push({ startUs: cursor, endUs: durationUs });
  return speech
    .map((span) => ({ startUs: Math.max(0, span.startUs - padding), endUs: Math.min(durationUs, span.endUs + padding) }))
    .reduce<SpeechSpan[]>((out, span) => {
      const last = out[out.length - 1];
      if (last && span.startUs <= last.endUs) last.endUs = Math.max(last.endUs, span.endUs);
      else out.push({ ...span });
      return out;
    }, [])
    .filter((span) => span.endUs - span.startUs >= minSpeech);
}

/** Pauses inferred from gaps between transcribed words — works without any audio analysis. */
export function pausesFromWords(words: TranscriptWord[], minGapUs: Microseconds = 450_000): SilenceSpan[] {
  const sorted = [...words].sort((a, b) => a.startUs - b.startUs);
  const pauses: SilenceSpan[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.startUs - previous.endUs >= minGapUs) pauses.push({ startUs: previous.endUs, endUs: current.startUs });
  }
  return pauses;
}

export function mergeSpans<T extends { startUs: number; endUs: number }>(spans: T[]): T[] {
  const sorted = [...spans].sort((a, b) => a.startUs - b.startUs);
  const out: T[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.startUs <= last.endUs) last.endUs = Math.max(last.endUs, span.endUs);
    else out.push({ ...span });
  }
  return out;
}
