import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProjectRevision, RenderSettings } from "@videocraft/domain";

export interface AssetPathResolver { resolve(assetId: string): Promise<string>; }
export interface RenderPlan { args: string[]; outputPath: string; }

export class FfmpegCommandPlanner {
  constructor(private readonly assets: AssetPathResolver) {}

  async plan(revision: ProjectRevision, settings: RenderSettings, outputPath: string): Promise<RenderPlan> {
    if (!outputPath || outputPath.includes("\0")) throw new Error("Output path is required");
    const videoTrack = revision.timeline.tracks.find((track) => track.kind === "video");
    const audioTrack = revision.timeline.tracks.find((track) => track.kind === "audio");
    if (!videoTrack || videoTrack.clips.length !== 1) throw new Error("Initial renderer supports exactly one video clip");
    if (audioTrack && audioTrack.clips.length > 1) throw new Error("Initial renderer supports at most one audio clip");

    const video = videoTrack.clips[0];
    const videoPath = await this.assets.resolve(video.assetId);
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", seconds(video.sourceStartUs),
      "-t", seconds(video.sourceEndUs - video.sourceStartUs),
      "-i", videoPath,
    ];

    if (audioTrack?.clips[0]) {
      const audio = audioTrack.clips[0];
      const audioPath = await this.assets.resolve(audio.assetId);
      args.push("-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-shortest");
    } else {
      args.push("-map", "0:v:0");
    }

    args.push(
      "-vf", "scale=" + even(settings.width) + ":" + even(settings.height) + ":force_original_aspect_ratio=decrease",
      "-r", String(settings.frameRate),
      "-c:v", settings.videoCodec,
      "-c:a", settings.audioCodec,
      "-movflags", "+faststart",
      outputPath,
    );
    return { args, outputPath };
  }
}

export class FfmpegProcess {
  constructor(private readonly executable = "ffmpeg") {}
  run(plan: RenderPlan, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child: ChildProcessWithoutNullStreams = spawn(this.executable, plan.args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => { signal?.removeEventListener("abort", abort); reject(error); });
      child.once("close", (code, terminationSignal) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return reject(new Error("FFmpeg render cancelled"));
        if (code !== 0) return reject(new Error("FFmpeg failed" + (terminationSignal ? " by " + terminationSignal : "") + (stderr ? ": " + stderr.slice(-4000) : "")));
        resolve();
      });
    });
  }
}

function seconds(microseconds: number): string {
  if (!Number.isSafeInteger(microseconds) || microseconds < 0) throw new Error("Time values must be non-negative safe integers");
  return (microseconds / 1_000_000).toFixed(6);
}
function even(value: number): number {
  if (!Number.isInteger(value) || value < 2 || value > 16_384) throw new Error("Video dimensions are invalid");
  return value % 2 === 0 ? value : value - 1;
}
