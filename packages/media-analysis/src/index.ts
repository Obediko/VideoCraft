import { spawn } from "node:child_process";
import { once } from "node:events";

export interface SilenceInterval {
  startUs: number;
  endUs: number;
}

export interface MediaAnalysis {
  durationUs: number;
  metadata: Record<string, string | number | boolean>;
  silenceIntervals: SilenceInterval[];
}

export interface MediaAnalyzer {
  analyze(path: string): Promise<MediaAnalysis>;
}

export interface FfprobeMediaAnalyzerOptions {
  ffprobeCommand?: string;
  ffmpegCommand?: string;
  timeoutMs?: number;
  silenceNoiseDb?: number;
  silenceDurationSeconds?: number;
}

export class FfprobeMediaAnalyzer implements MediaAnalyzer {
  private readonly options: Required<FfprobeMediaAnalyzerOptions>;

  constructor(options: FfprobeMediaAnalyzerOptions = {}) {
    this.options = {
      ffprobeCommand: options.ffprobeCommand ?? "ffprobe",
      ffmpegCommand: options.ffmpegCommand ?? "ffmpeg",
      timeoutMs: options.timeoutMs ?? 120_000,
      silenceNoiseDb: options.silenceNoiseDb ?? -35,
      silenceDurationSeconds: options.silenceDurationSeconds ?? 0.35,
    };
  }

  async analyze(path: string): Promise<MediaAnalysis> {
    if (!path || path.includes("\\0")) throw new Error("Media path is required");
    const probe = await this.run(this.options.ffprobeCommand, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
      "-of", "json", path,
    ]);
    const parsed = parseProbe(probe);
    const silenceOutput = await this.run(this.options.ffmpegCommand, [
      "-hide_banner", "-nostats", "-i", path, "-af",
      `silencedetect=noise=${this.options.silenceNoiseDb}dB:d=${this.options.silenceDurationSeconds}`,
      "-f", "null", "-",
    ], true);
    return {
      durationUs: parsed.durationUs,
      metadata: {
        ...parsed.metadata,
        silenceIntervalCount: silenceOutput.intervals.length,
        silenceIntervalsJson: JSON.stringify(silenceOutput.intervals),
      },
      silenceIntervals: silenceOutput.intervals,
    };
  }

  private async run(command: string, args: string[], allowNonZero = false): Promise<{ stdout: string; stderr: string; intervals: SilenceInterval[] }> {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill("SIGTERM"), this.options.timeoutMs);
    const [code] = await once(child, "close") as [number | null];
    clearTimeout(timer);
    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    if (code !== 0 && !allowNonZero) throw new Error(command + " failed: " + err.slice(-2000));
    return { stdout: out, stderr: err, intervals: parseSilence(err) };
  }
}

function parseProbe(value: { stdout: string; stderr: string; intervals: SilenceInterval[] }): { durationUs: number; metadata: Record<string, string | number | boolean> } {
  let document: any;
  try { document = JSON.parse(value.stdout); } catch { throw new Error("ffprobe returned invalid JSON"); }
  const duration = Number(document?.format?.duration);
  if (!Number.isFinite(duration) || duration < 0 || duration * 1_000_000 > Number.MAX_SAFE_INTEGER) throw new Error("Media duration is unavailable");
  const streams = Array.isArray(document?.streams) ? document.streams : [];
  const video = streams.find((stream: any) => stream?.codec_type === "video");
  const audio = streams.find((stream: any) => stream?.codec_type === "audio");
  const metadata: Record<string, string | number | boolean> = {
    ...(typeof video?.codec_name === "string" ? { videoCodec: video.codec_name } : {}),
    ...(typeof audio?.codec_name === "string" ? { audioCodec: audio.codec_name } : {}),
    ...(Number.isFinite(Number(video?.width)) ? { width: Number(video.width) } : {}),
    ...(Number.isFinite(Number(video?.height)) ? { height: Number(video.height) } : {}),
    ...(typeof video?.avg_frame_rate === "string" ? { frameRate: video.avg_frame_rate } : {}),
    ...(typeof audio?.sample_rate === "string" ? { sampleRate: Number(audio.sample_rate) } : {}),
    ...(Number.isFinite(Number(audio?.channels)) ? { audioChannels: Number(audio.channels) } : {}),
  };
  return { durationUs: Math.round(duration * 1_000_000), metadata };
}

function parseSilence(stderr: string): SilenceInterval[] {
  const starts: number[] = [];
  const intervals: SilenceInterval[] = [];
  for (const line of stderr.split(/\\r?\\n/)) {
    const start = line.match(/silence_start:\\s*([0-9.]+)/);
    const end = line.match(/silence_end:\\s*([0-9.]+)/);
    if (start) starts.push(Number(start[1]) * 1_000_000);
    if (end && starts.length) {
      const startUs = Math.round(starts.shift()!);
      const endUs = Math.round(Number(end[1]) * 1_000_000);
      if (endUs > startUs) intervals.push({ startUs, endUs });
    }
  }
  return intervals;
}
