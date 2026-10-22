import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { renderAss, resolveCaptionStyle, type TimedCue } from "@videocraft/captions";
import type { ProjectRevision, RenderSettings, TimelineClip, TimelineTrack } from "@videocraft/domain";

export interface AssetPathResolver {
  resolve(assetId: string): Promise<string>;
  /** Whether the staged asset has an audio stream. When omitted, assets are assumed silent. */
  hasAudio?(assetId: string): Promise<boolean>;
}
export interface RenderPlan { args: string[]; outputPath: string; /** Side files (e.g. caption documents) written before FFmpeg starts. */ files: Array<{ path: string; content: string }>; }

export interface PlatformPreset { id: string; label: string; settings: RenderSettings; }

const base = { format: "mp4", videoCodec: "libx264", audioCodec: "aac", frameRate: 30 } as const;
export const PLATFORM_PRESETS: Record<string, PlatformPreset> = {
  tiktok: { id: "tiktok", label: "TikTok 9:16", settings: { ...base, width: 1080, height: 1920, fit: "cover", captionStyle: "bold-pop" } },
  "instagram-reels": { id: "instagram-reels", label: "Instagram Reels 9:16", settings: { ...base, width: 1080, height: 1920, fit: "cover", captionStyle: "bold-pop" } },
  "youtube-shorts": { id: "youtube-shorts", label: "YouTube Shorts 9:16", settings: { ...base, width: 1080, height: 1920, fit: "cover", captionStyle: "bold-pop" } },
  youtube: { id: "youtube", label: "YouTube 16:9", settings: { ...base, width: 1920, height: 1080, fit: "contain", captionStyle: "clean" } },
  "linkedin-square": { id: "linkedin-square", label: "LinkedIn / Feed 1:1", settings: { ...base, width: 1080, height: 1080, fit: "cover", captionStyle: "clean" } },
  web: { id: "web", label: "Web 16:9 (720p)", settings: { ...base, width: 1280, height: 720, fit: "contain", captionStyle: "clean" } },
};

/** Maps a tailoring channel ("short-form", "youtube", "web", a platform id…) to render settings. */
export function presetForChannel(channel: string): PlatformPreset {
  const key = channel.trim().toLowerCase();
  const preset = PLATFORM_PRESETS[key];
  if (preset) return preset;
  if (key === "short-form" || key === "shorts" || key === "reels") return PLATFORM_PRESETS["tiktok"] as PlatformPreset;
  return PLATFORM_PRESETS["web"] as PlatformPreset;
}

export class FfmpegCommandPlanner {
  constructor(private readonly assets: AssetPathResolver) {}

  async plan(revision: ProjectRevision, settings: RenderSettings, outputPath: string): Promise<RenderPlan> {
    if (!outputPath || outputPath.includes("\0")) throw new Error("Output path is required");
    const tracks = revision.timeline.tracks;
    const videoTrack = tracks.find((track) => track.kind === "video");
    const audioTrack = tracks.find((track) => track.kind === "audio");
    const clips = [...(videoTrack?.clips ?? [])].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
    if (clips.length === 0) throw new Error("Timeline has no video clips to render");
    if (audioTrack && audioTrack.clips.length > 1) throw new Error("Renderer supports at most one external audio clip");

    const width = even(settings.width);
    const height = even(settings.height);
    const fps = settings.frameRate;
    if (!Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error("Frame rate is invalid");

    // One input per clip, seeked to the clip start. Opening a clip's own input keeps memory flat
    // when clips are reordered; sharing one input would force the decoder to buffer every frame
    // between two out-of-order clips (gigabytes for vertical 1080p).
    const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];
    const audioPresent = new Map<string, boolean>();
    for (const clip of clips) {
      const length = (clip.sourceEndUs - clip.sourceStartUs) / 1_000_000;
      if (!(length > 0)) throw new Error("Clip has an invalid source range");
      if (!audioPresent.has(clip.assetId)) audioPresent.set(clip.assetId, this.assets.hasAudio ? await this.assets.hasAudio(clip.assetId) : false);
      args.push("-ss", seconds(clip.sourceStartUs), "-t", length.toFixed(6), "-i", await this.assets.resolve(clip.assetId));
    }

    const externalAudio = audioTrack?.clips[0];
    let externalIndex = -1;
    if (externalAudio) {
      externalIndex = clips.length;
      args.push("-i", await this.assets.resolve(externalAudio.assetId));
    }

    const fit = settings.fit === "cover"
      ? "scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,crop=" + width + ":" + height
      : "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2:color=black";

    const useEmbeddedAudio = !externalAudio && [...audioPresent.values()].some(Boolean);
    const filters: string[] = [];
    const concatInputs: string[] = [];
    clips.forEach((clip, index) => {
      const length = (clip.sourceEndUs - clip.sourceStartUs) / 1_000_000;
      filters.push("[" + index + ":v]setpts=PTS-STARTPTS," + fit + ",fps=" + fps + ",setsar=1,format=yuv420p[v" + index + "]");
      concatInputs.push("[v" + index + "]");
      if (useEmbeddedAudio) {
        if (audioPresent.get(clip.assetId)) {
          const fade = Math.min(0.015, length / 4).toFixed(3);
          filters.push("[" + index + ":a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,atrim=duration=" + length.toFixed(6) + ",afade=t=in:d=" + fade + ",afade=t=out:st=" + Math.max(0, length - Number(fade)).toFixed(3) + ":d=" + fade + "[a" + index + "]");
        } else {
          filters.push("anullsrc=r=48000:cl=stereo,atrim=duration=" + length.toFixed(6) + ",asetpts=PTS-STARTPTS[a" + index + "]");
        }
        concatInputs.push("[a" + index + "]");
      }
    });
    filters.push(concatInputs.join("") + "concat=n=" + clips.length + ":v=1:a=" + (useEmbeddedAudio ? 1 : 0) + "[vcat]" + (useEmbeddedAudio ? "[acat]" : ""));

    const files: RenderPlan["files"] = [];
    const style = resolveCaptionStyle(settings.captionStyle);
    const cues = style ? captionCues(tracks, videoTrack, revision.timeline.durationUs) : [];
    let videoLabel = "[vcat]";
    if (style && cues.length > 0) {
      const assPath = outputPath + ".captions.ass";
      files.push({ path: assPath, content: renderAss(cues, style, { width, height }) });
      filters.push("[vcat]ass=filename='" + escapeFilterPath(assPath) + "'[vout]");
      videoLabel = "[vout]";
    }

    args.push("-filter_complex", filters.join(";"), "-map", videoLabel);
    if (externalAudio) {
      args.push("-map", externalIndex + ":a:0", "-af", "atrim=start=" + seconds(externalAudio.sourceStartUs) + ":end=" + seconds(externalAudio.sourceEndUs) + ",asetpts=PTS-STARTPTS", "-shortest");
    } else if (useEmbeddedAudio) {
      args.push("-map", "[acat]");
    }
    args.push("-r", String(fps), "-c:v", settings.videoCodec);
    if (settings.videoCodec === "libx264") args.push("-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p");
    if (externalAudio || useEmbeddedAudio) args.push("-c:a", settings.audioCodec);
    args.push("-movflags", "+faststart", outputPath);
    return { args, outputPath, files };
  }
}

function captionCues(tracks: TimelineTrack[], video: TimelineTrack | undefined, durationUs: number): TimedCue[] {
  const end = video ? Math.max(0, ...video.clips.map((clip: TimelineClip) => clip.timelineEndUs)) : durationUs;
  const cues: TimedCue[] = [];
  for (const track of tracks) {
    if (track.kind !== "caption") continue;
    for (const clip of track.clips) {
      const text = clip.transform?.text;
      if (typeof text !== "string" || !text.trim()) continue;
      const startUs = clip.timelineStartUs;
      const endUs = Math.min(clip.timelineEndUs, end);
      if (endUs <= startUs) continue;
      const rawTimings = clip.transform?.wordDurationsCs;
      const wordDurationsCs = typeof rawTimings === "string" ? rawTimings.split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0) : undefined;
      cues.push({ startUs, endUs, text: text.slice(0, 1_000), ...(wordDurationsCs?.length ? { wordDurationsCs } : {}) });
    }
  }
  return cues;
}

export class FfmpegProcess {
  constructor(private readonly executable = "ffmpeg") {}
  async run(plan: RenderPlan, signal?: AbortSignal): Promise<void> {
    for (const file of plan.files) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content, "utf8");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, plan.args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
function escapeFilterPath(path: string): string {
  if (path.includes("\0") || path.includes("\n") || path.includes("'")) throw new Error("Invalid caption path");
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}
