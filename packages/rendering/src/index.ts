import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { captionBand, captionBandAt, captionMarginFor, faceDuring, faceInOutput, focusFromTrack, renderAss, renderGraphicsAss, resolveCaptionStyle, type CaptionStyle, type FaceTrack, type GraphicItem, type PixelBox, type TimedCue } from "@videocraft/captions";
import type { ProjectRevision, RenderSettings, TimelineClip, TimelineTrack } from "@videocraft/domain";
import { encodeWav, generateSoundEffect, type SoundEffectKind } from "@videocraft/music";

export interface AssetPathResolver {
  resolve(assetId: string): Promise<string>;
  /** Whether the staged asset has an audio stream. When omitted, assets are assumed silent. */
  hasAudio?(assetId: string): Promise<boolean>;
  /** Subject position (0..1) within a source range, used to aim cover-crops. Null means "use the centre". */
  /** Whether the asset is a still image (looped for its on-screen time). Without it, assets are treated as video. */
  isStill?(assetId: string): Promise<boolean>;
  focus?(assetId: string, startUs: number, endUs: number): Promise<{ x: number; y: number; confidence: number } | null>;
  /** Where the speaker's face is through the asset, so captions and text can stay off it. Null when unknown. */
  faces?(assetId: string): Promise<FaceTrack | null>;
  /**
   * A person matte for a source range of the asset (path to a greyscale video starting at the range start, at the
   * source frame rate): white where the person is. Null when matting is unavailable; backgrounds are then skipped.
   */
  matte?(assetId: string, startUs: number, endUs: number, options: { edge: number; feather: number }): Promise<string | null>;
  /** Display size of the asset's picture (after rotation). Needed to place text around faces. */
  dimensions?(assetId: string): Promise<{ width: number; height: number } | null>;
}
export interface RenderPlan { args: string[]; outputPath: string; /** Side files (caption documents, generated sound effects) written before FFmpeg starts. */ files: Array<{ path: string; content: string | Uint8Array }>; }

/** Colour looks as FFmpeg filter chains (applied per clip, after framing). */
// YUV-only filters (eq, lutyuv, hue, vignette, unsharp): RGB filters such as colorbalance or curves cost 3-5x the
// render time on the ARM server.
export const LOOK_FILTERS: Record<string, string> = {
  warm: "lutyuv=u='val-6':v='val+5',eq=saturation=1.08:contrast=1.03",
  clean: "eq=contrast=1.06:saturation=1.06:brightness=0.01,unsharp=5:5:0.35",
  cinematic: "eq=contrast=1.1:saturation=0.88,lutyuv=u='val+3':v='val+2',vignette=PI/5",
  vivid: "eq=saturation=1.3:contrast=1.08",
  soft: "eq=contrast=0.93:saturation=0.94:brightness=0.025",
  mono: "hue=s=0,eq=contrast=1.12",
};
const TRANSITION_SECONDS: Record<string, number> = { "dip-black": 0.25, "dip-white": 0.25, flash: 0.12 };

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

  /**
   * Where the face is on screen (output pixels) during a stretch of the edit: the union over the clips showing then,
   * following each clip's crop and zoom. Without a face track or the source size, nothing is avoided.
   */
  async loadFaceData(clips: TimelineClip[]): Promise<{ tracks: Map<string, FaceTrack | null>; sizes: Map<string, { width: number; height: number } | null> }> {
    const tracks = new Map<string, FaceTrack | null>(); const sizes = new Map<string, { width: number; height: number } | null>();
    if (!this.assets.faces) return { tracks, sizes };
    for (const assetId of new Set(clips.map((clip) => clip.assetId))) {
      try { tracks.set(assetId, await this.assets.faces(assetId)); } catch { tracks.set(assetId, null); }
      try { sizes.set(assetId, this.assets.dimensions ? await this.assets.dimensions(assetId) : null); } catch { sizes.set(assetId, null); }
    }
    return { tracks, sizes };
  }

  faceLocator(data: { tracks: Map<string, FaceTrack | null>; sizes: Map<string, { width: number; height: number } | null> }, clips: TimelineClip[], focus: Array<{ x: number; y: number } | null>, fit: "cover" | "contain", output: { width: number; height: number }): (startUs: number, endUs: number) => PixelBox | undefined {
    const { tracks, sizes } = data;
    return (startUs, endUs) => {
      let union: PixelBox | undefined;
      clips.forEach((clip, index) => {
        const from = Math.max(startUs, clip.timelineStartUs); const to = Math.min(endUs, clip.timelineEndUs);
        const track = tracks.get(clip.assetId); const source = sizes.get(clip.assetId);
        if (to <= from || !track || !source) return;
        const box = faceDuring(track, clip.sourceStartUs + (from - clip.timelineStartUs), clip.sourceStartUs + (to - clip.timelineStartUs));
        const placed = box ? faceInOutput(box, { source, output, fit, focus: focus[index] ?? null, ...(typeof clip.transform?.zoom === "string" ? { zoom: clip.transform.zoom } : {}) }) : undefined;
        if (placed) union = union ? { x0: Math.min(union.x0, placed.x0), y0: Math.min(union.y0, placed.y0), x1: Math.max(union.x1, placed.x1), y1: Math.max(union.y1, placed.y1) } : placed;
      });
      return union;
    };
  }

  async plan(revision: ProjectRevision, settings: RenderSettings, outputPath: string): Promise<RenderPlan> {
    if (!outputPath || outputPath.includes("\0")) throw new Error("Output path is required");
    const tracks = revision.timeline.tracks;
    const videoTrack = tracks.find((track) => track.kind === "video");
    const audioTrack = tracks.find((track) => track.kind === "audio");
    const clips = [...(videoTrack?.clips ?? [])].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
    if (clips.length === 0) throw new Error("Timeline has no video clips to render");
    // An audio-track clip is either background music (transform.role "music": mixed under the speech) or,
    // without a role, a replacement soundtrack. One of each kind at most.
    const musicClips = (audioTrack?.clips ?? []).filter((clip) => clip.transform?.role === "music");
    const sfxClips = (audioTrack?.clips ?? []).filter((clip) => clip.transform?.role === "sfx" && clip.timelineEndUs > clip.timelineStartUs).sort((a, b) => a.timelineStartUs - b.timelineStartUs).slice(0, 40);
    const replacementClips = (audioTrack?.clips ?? []).filter((clip) => clip.transform?.role !== "music" && clip.transform?.role !== "sfx");
    if (musicClips.length > 1 || replacementClips.length > 1) throw new Error("Renderer supports at most one music bed and one replacement audio clip");

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

    let nextInput = clips.length;
    const externalAudio = replacementClips[0];
    let externalIndex = -1;
    if (externalAudio) {
      externalIndex = nextInput++;
      args.push("-i", await this.assets.resolve(externalAudio.assetId));
    }
    const music = musicClips[0];
    let musicIndex = -1;
    if (music) {
      musicIndex = nextInput++;
      // Looped so a short track covers a long cut; trimmed to the timeline in the graph.
      args.push("-stream_loop", "-1", "-ss", seconds(music.sourceStartUs), "-i", await this.assets.resolve(music.assetId));
    }
    // B-roll inputs: stills are looped for their on-screen time, videos are seeked to their start.
    const brolls = tracks.filter((track) => track.kind === "overlay").flatMap((track) => track.clips).filter((clip) => clip.transform?.role === "broll" && clip.timelineEndUs > clip.timelineStartUs).sort((a, b) => a.timelineStartUs - b.timelineStartUs);
    if (brolls.length > 20) throw new Error("Renderer supports at most 20 B-roll overlays");
    const brollInputs: number[] = [];
    const brollStill: boolean[] = [];
    for (const broll of brolls) {
      const length = ((broll.timelineEndUs - broll.timelineStartUs) / 1_000_000).toFixed(6);
      const still = this.assets.isStill ? await this.assets.isStill(broll.assetId) : false;
      brollInputs.push(nextInput++);
      brollStill.push(still);
      if (still) args.push("-loop", "1", "-framerate", String(fps), "-t", length, "-i", await this.assets.resolve(broll.assetId));
      else args.push("-ss", seconds(broll.sourceStartUs), "-t", length, "-i", await this.assets.resolve(broll.assetId));
    }
    // Generated sound effects: one WAV per kind, one input per use (each is delayed to its moment).
    const files: RenderPlan["files"] = [];
    const sfxInputs: number[] = [];
    const sfxKinds = new Set<string>();
    for (const sfx of sfxClips) {
      const kind = String(sfx.transform?.kind) as SoundEffectKind;
      if (!["whoosh", "pop", "hit", "riser"].includes(kind)) continue;
      const path = outputPath + ".sfx-" + kind + ".wav";
      if (!sfxKinds.has(kind)) { const fx = generateSoundEffect(kind); files.push({ path, content: encodeWav(fx.left, fx.right, fx.sampleRate) }); sfxKinds.add(kind); }
      sfxInputs.push(nextInput++);
      args.push("-i", path);
    }
    // Backgrounds behind the person (blur, colour, a photo or clip) and cutaways placed behind them need a matte.
    const behind = brolls.map((broll) => broll.transform?.mode === "behind");
    const overlapsBehind = (clip: TimelineClip) => brolls.some((broll, i) => behind[i] && broll.timelineStartUs < clip.timelineEndUs && broll.timelineEndUs > clip.timelineStartUs);
    const matteInputs: Array<number | undefined> = [];
    const backgroundInputs: Array<{ index: number; still: boolean } | undefined> = [];
    for (const clip of clips) {
      const kind = String(clip.transform?.background ?? "none");
      const wanted = (kind !== "none" && BACKGROUND_KINDS.has(kind)) || overlapsBehind(clip);
      let matteIndex: number | undefined;
      if (wanted && this.assets.matte) {
        const edge = clampNumber(Number(clip.transform?.matteEdge ?? 0), -8, 8); const feather = clampNumber(Number(clip.transform?.matteFeather ?? 2), 0, 12);
        const path = await this.assets.matte(clip.assetId, clip.sourceStartUs, clip.sourceEndUs, { edge: Math.round(edge), feather: Math.round(feather) }).catch(() => null);
        if (path) { matteIndex = nextInput++; args.push("-t", ((clip.sourceEndUs - clip.sourceStartUs) / 1_000_000).toFixed(6), "-i", path); }
      }
      matteInputs.push(matteIndex);
      const backgroundAsset = clip.transform?.backgroundAssetId;
      if (matteIndex !== undefined && kind === "media" && typeof backgroundAsset === "string") {
        const still = this.assets.isStill ? await this.assets.isStill(backgroundAsset) : false;
        const length = ((clip.sourceEndUs - clip.sourceStartUs) / 1_000_000).toFixed(6);
        const index = nextInput++;
        if (still) args.push("-loop", "1", "-framerate", String(fps), "-t", length, "-i", await this.assets.resolve(backgroundAsset));
        else args.push("-stream_loop", "-1", "-t", length, "-i", await this.assets.resolve(backgroundAsset));
        backgroundInputs.push({ index, still });
      } else backgroundInputs.push(undefined);
    }
    const anyBehind = behind.some(Boolean) && matteInputs.some((index) => index !== undefined);
    const totalSeconds = clips.reduce((sum, clip) => sum + (clip.sourceEndUs - clip.sourceStartUs), 0) / 1_000_000;

    const contain = "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2:color=black";
    const focusUsed: Array<{ x: number; y: number } | null> = clips.map(() => null);
    const faceData = await this.loadFaceData(clips);
    const fitFor = async (clip: TimelineClip, index: number): Promise<string> => {
      if (settings.fit !== "cover") return contain;
      // A manual focus on the clip wins; otherwise ask the resolver to find the subject.
      const manualX = Number(clip.transform?.focusX);
      const manualY = Number(clip.transform?.focusY);
      let focus: { x: number; y: number } | null = Number.isFinite(manualX) && Number.isFinite(manualY) ? { x: manualX, y: manualY } : null;
      // The face track (shared with captions and the live preview) aims the crop; the focus detector is the fallback.
      if (!focus) { const fromTrack = focusFromTrack(faceData.tracks.get(clip.assetId) ?? undefined, clip.sourceStartUs, clip.sourceEndUs); if (fromTrack) focus = fromTrack; }
      if (!focus && this.assets.focus && !faceData.tracks.get(clip.assetId)) {
        const found = await this.assets.focus(clip.assetId, clip.sourceStartUs, clip.sourceEndUs);
        if (found && found.confidence >= 0.3) focus = found;
      }
      focusUsed[index] = focus;
      return "scale=" + width + ":" + height + ":force_original_aspect_ratio=increase," + coverCrop(width, height, focus);
    };
    const fits = await Promise.all(clips.map((clip, index) => fitFor(clip, index)));

    const useEmbeddedAudio = !externalAudio && [...audioPresent.values()].some(Boolean);
    const filters: string[] = [];
    const concatInputs: string[] = [];
    const matteConcat: string[] = [];
    clips.forEach((clip, index) => {
      const length = (clip.sourceEndUs - clip.sourceStartUs) / 1_000_000;
      const matteIndex = matteInputs[index];
      if (matteIndex === undefined) {
        filters.push("[" + index + ":v]setpts=PTS-STARTPTS," + fits[index] + ",fps=" + fps + clipEffects(clips, index, width, height, length) + ",setsar=1,format=yuv420p[v" + index + "]");
        if (anyBehind) matteConcat.push("color=c=white:s=" + width + "x" + height + ":r=" + fps + ":d=" + length.toFixed(6) + ",format=gray,setsar=1[mw" + index + "]");
      } else {
        // The matte is framed exactly like the picture (same fit, frame rate and zoom), then used as its alpha.
        const zoom = clipZoom(clip, width, height, length);
        const kind = String(clip.transform?.background ?? "none");
        filters.push("[" + index + ":v]setpts=PTS-STARTPTS," + fits[index] + ",fps=" + fps + zoom + ",setsar=1,format=yuv420p,split=2[fg" + index + "][src" + index + "]");
        filters.push("[" + matteIndex + ":v]setpts=PTS-STARTPTS," + fits[index] + ",fps=" + fps + zoom + ",setsar=1,format=gray" + (anyBehind ? ",split=2[ma" + index + "][mw" + index + "]" : "[ma" + index + "]"));
        let base: string | undefined;
        if (kind === "blur") { filters.push("[src" + index + "]boxblur=luma_radius=" + Math.max(8, Math.round(Math.min(width, height) / 40)) + ":luma_power=2[bg" + index + "]"); base = "[bg" + index + "]"; }
        else {
          filters.push("[src" + index + "]nullsink");
          if (kind === "color") { filters.push("color=c=0x" + hexColour(clip.transform?.backgroundColor) + ":s=" + width + "x" + height + ":r=" + fps + ":d=" + length.toFixed(6) + ",format=yuv420p,setsar=1[bg" + index + "]"); base = "[bg" + index + "]"; }
          else if (kind === "media" && backgroundInputs[index]) {
            filters.push("[" + backgroundInputs[index]!.index + ":v]setpts=PTS-STARTPTS,scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,crop=" + width + ":" + height + ",fps=" + fps + ",trim=duration=" + length.toFixed(6) + ",setsar=1,format=yuv420p[bg" + index + "]");
            base = "[bg" + index + "]";
          }
        }
        const finish = clipFinish(clips, index, length);
        if (base) {
          filters.push("[fg" + index + "][ma" + index + "]alphamerge[cut" + index + "]");
          filters.push(base + "[cut" + index + "]overlay=format=auto:shortest=1" + finish + ",setsar=1,format=yuv420p[v" + index + "]");
        } else {
          // No background change on this clip (the matte is only for a cutaway behind the person).
          filters.push("[ma" + index + "]nullsink");
          filters.push("[fg" + index + "]null" + finish + ",setsar=1,format=yuv420p[v" + index + "]");
        }
      }
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
    if (anyBehind) {
      filters.push(...matteConcat);
      filters.push(clips.map((_, index) => "[mw" + index + "]").join("") + "concat=n=" + clips.length + ":v=1:a=0[mcat]");
      // The person, cut out of the finished picture, goes back on top of cutaways placed behind them.
      filters.push("[vcat]split=2[vbase][vperson]", "[vperson][mcat]alphamerge[person]");
    }

    const style = resolveCaptionStyle(settings.captionStyle);
    const faceFor = this.faceLocator(faceData, clips, focusUsed, settings.fit === "cover" ? "cover" : "contain", { width, height });
    const cues = style ? placeCaptions(captionCues(tracks, videoTrack, revision.timeline.durationUs), style, { width, height }, faceFor) : [];
    let videoLabel = anyBehind ? "[vbase]" : "[vcat]";
    brolls.forEach((broll, index) => {
      const start = (broll.timelineStartUs / 1_000_000).toFixed(6);
      const end = (broll.timelineEndUs / 1_000_000).toFixed(6);
      const pip = broll.transform?.mode === "pip";
      const insetWidth = even(Math.max(2, Math.round(width * (width < height ? 0.5 : 0.32))));
      const margin = Math.round(Math.min(width, height) * 0.04);
      const duration = (broll.timelineEndUs - broll.timelineStartUs) / 1_000_000;
      // Stills drift slowly (a gentle pan and push) so they never look frozen, unless motion is "none".
      const moving = brollStill[index] && broll.transform?.motion !== "none" && !pip;
      const scale = pip ? "scale=" + insetWidth + ":-2"
        : moving ? "scale=" + even(Math.round(width * 1.12)) + ":" + even(Math.round(height * 1.12)) + ":force_original_aspect_ratio=increase,crop=" + even(Math.round(width * 1.12)) + ":" + even(Math.round(height * 1.12)) + ",fps=" + fps + ",scale=w='2*trunc(" + width + "*(1.12+0.06*t/" + duration.toFixed(3) + ")/2)':h=-2:eval=frame,crop=" + width + ":" + height + ":x='(iw-ow)*min(1,t/" + duration.toFixed(3) + ")':y='(ih-oh)/2'"
        : "scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,crop=" + width + ":" + height;
      filters.push("[" + brollInputs[index] + ":v]" + scale + ",fps=" + fps + ",setsar=1,format=yuva420p,setpts=PTS-STARTPTS+" + start + "/TB[b" + index + "]");
      // Inset sits top-right, clear of the bottom caption band.
      const position = pip ? "x=W-w-" + margin + ":y=" + margin : "x=0:y=0";
      filters.push(videoLabel + "[b" + index + "]overlay=" + position + ":enable='between(t," + start + "," + end + ")':eof_action=pass[ov" + index + "]");
      videoLabel = "[ov" + index + "]";
    });
    if (anyBehind) {
      const windows = brolls.map((broll, index) => (behind[index] ? "between(t," + (broll.timelineStartUs / 1_000_000).toFixed(6) + "," + (broll.timelineEndUs / 1_000_000).toFixed(6) + ")" : "")).filter(Boolean);
      filters.push(videoLabel + "[person]overlay=format=auto:enable='" + windows.join("+") + "'[behind]");
      videoLabel = "[behind]";
    }
    // Motion graphics (title cards, callouts, lower thirds, progress bar): above b-roll, beneath captions.
    const overlayClips = tracks.filter((track) => track.kind === "overlay").flatMap((track) => track.clips);
    const faceAndBand = (startUs: number, endUs: number): Pick<GraphicItem, "face" | "avoid"> => {
      const face = faceFor(startUs, endUs);
      const during = style ? cues.filter((cue) => cue.startUs < endUs && cue.endUs > startUs) : [];
      const bands = during.map((cue) => captionBandAt(style!, height, cue.marginV ?? Math.round(height * style!.bottomRatio)));
      const avoid = bands.length ? { topY: Math.min(...bands.map((b) => b.topY)), bottomY: Math.max(...bands.map((b) => b.bottomY)) } : undefined;
      return { ...(face ? { face } : {}), ...(avoid ? { avoid } : {}) };
    };
    const graphics: GraphicItem[] = overlayClips.filter((clip) => clip.transform?.role === "graphic" && typeof clip.transform.text === "string").map((clip) => ({
      kind: clip.transform!.kind === "lower-third" ? "lower-third" : clip.transform!.kind === "callout" ? "callout" : "title",
      text: String(clip.transform!.text).slice(0, 120), startUs: clip.timelineStartUs, endUs: clip.timelineEndUs,
      ...(typeof clip.transform!.subtitle === "string" ? { subtitle: clip.transform!.subtitle.slice(0, 120) } : {}),
      ...(clip.transform!.position === "top" || clip.transform!.position === "bottom" || clip.transform!.position === "center" ? { position: clip.transform!.position } : {}),
      ...(typeof clip.transform!.color === "string" ? { color: clip.transform!.color } : {}),
      ...faceAndBand(clip.timelineStartUs, clip.timelineEndUs),
    }));
    const progressClip = overlayClips.find((clip) => clip.transform?.role === "progress");
    if (graphics.length > 0 || progressClip) {
      const graphicsPath = outputPath + ".graphics.ass";
      files.push({ path: graphicsPath, content: renderGraphicsAss(graphics, progressClip ? { startUs: 0, endUs: Math.round(totalSeconds * 1_000_000), ...(typeof progressClip.transform?.color === "string" ? { color: progressClip.transform.color } : {}) } : undefined, { width, height }, style && cues.length > 0 ? { avoid: captionBand(style, height) } : {}) });
      filters.push(videoLabel + "ass=filename='" + escapeFilterPath(graphicsPath) + "'[gfx]");
      videoLabel = "[gfx]";
    }
    if (style && cues.length > 0) {
      const assPath = outputPath + ".captions.ass";
      files.push({ path: assPath, content: renderAss(cues, style, { width, height }) });
      filters.push(videoLabel + "ass=filename='" + escapeFilterPath(assPath) + "'[vout]");
      videoLabel = "[vout]";
    }

    let audioLabel = useEmbeddedAudio ? "[acat]" : "";
    if (music && !externalAudio) {
      const volumeDb = clampNumber(Number(music.transform?.volumeDb ?? -16), -40, 0);
      const fadeOut = Math.min(1.5, totalSeconds / 4);
      filters.push("[" + musicIndex + ":a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=" + totalSeconds.toFixed(6) + ",asetpts=PTS-STARTPTS,volume=" + volumeDb + "dB,afade=t=in:d=" + Math.min(1, totalSeconds / 4).toFixed(3) + ",afade=t=out:st=" + Math.max(0, totalSeconds - fadeOut).toFixed(3) + ":d=" + fadeOut.toFixed(3) + "[mus]");
      if (useEmbeddedAudio) {
        if (music.transform?.duck !== false) {
          // Duck the music whenever someone speaks: the speech drives a sidechain compressor on the music.
          filters.push("[acat]asplit=2[speech][key]");
          filters.push("[mus][key]sidechaincompress=threshold=0.012:ratio=12:attack=15:release=350[ducked]");
          filters.push("[speech][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amix]");
        } else {
          filters.push("[acat][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amix]");
        }
        audioLabel = "[amix]";
      } else {
        audioLabel = "[mus]";
      }
    }
    if (sfxInputs.length > 0 && !externalAudio) {
      const labels: string[] = [];
      sfxClips.forEach((sfx, i) => {
        if (sfxInputs[i] === undefined) return;
        const delayMs = Math.round(sfx.timelineStartUs / 1000);
        const length = ((sfx.timelineEndUs - sfx.timelineStartUs) / 1_000_000).toFixed(6);
        const volume = clampNumber(Number(sfx.transform?.volumeDb ?? -10), -40, 0);
        filters.push("[" + sfxInputs[i] + ":a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=" + length + ",volume=" + volume + "dB,adelay=" + delayMs + "|" + delayMs + "[fx" + i + "]");
        labels.push("[fx" + i + "]");
      });
      if (!audioLabel) { filters.push("anullsrc=r=48000:cl=stereo,atrim=duration=" + totalSeconds.toFixed(6) + "[abed]"); audioLabel = "[abed]"; }
      filters.push(audioLabel + labels.join("") + "amix=inputs=" + (labels.length + 1) + ":duration=first:dropout_transition=0:normalize=0[asfx]");
      audioLabel = "[asfx]";
    }
    if (audioLabel && settings.normalizeLoudness !== false) {
      // Single-pass EBU R128 normalisation so clips cut from quiet and loud parts of a source sound consistent.
      filters.push(audioLabel + "loudnorm=I=" + (settings.loudnessLufs ?? -16) + ":TP=-1.5:LRA=11[anorm]");
      audioLabel = "[anorm]";
    }
    args.push("-filter_complex", filters.join(";"), "-map", videoLabel);
    if (externalAudio) {
      args.push("-map", externalIndex + ":a:0", "-af", "atrim=start=" + seconds(externalAudio.sourceStartUs) + ":end=" + seconds(externalAudio.sourceEndUs) + ",asetpts=PTS-STARTPTS", "-shortest");
    } else if (audioLabel) {
      args.push("-map", audioLabel);
    }
    args.push("-r", String(fps), "-c:v", settings.videoCodec);
    if (settings.videoCodec === "libx264") args.push("-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p");
    if (externalAudio || audioLabel) args.push("-c:a", settings.audioCodec);
    args.push("-movflags", "+faststart", outputPath);
    return { args, outputPath, files };
  }
}

/** Gives each caption the margin that keeps it off the speaker's face at that moment. */
export function placeCaptions(cues: TimedCue[], style: CaptionStyle, frame: { width: number; height: number }, faceFor: (startUs: number, endUs: number) => PixelBox | undefined): TimedCue[] {
  return cues.map((cue) => {
    const face = faceFor(cue.startUs, cue.endUs);
    if (!face) return cue;
    const marginV = captionMarginFor(face, style, frame, 2);
    return marginV === Math.round(frame.height * style.bottomRatio) ? cue : { ...cue, marginV };
  });
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

/** Zoom, look and transitions for one clip (appended to its chain after framing). */
export function clipEffects(clips: TimelineClip[], index: number, width: number, height: number, lengthS: number): string {
  return clipZoom(clips[index]!, width, height, lengthS) + clipFinish(clips, index, lengthS);
}

/** The clip's zoom (framing only, so a matte can be framed the same way). */
export function clipZoom(clip: TimelineClip, width: number, height: number, lengthS: number): string {
  const t = clip.transform ?? {};
  // Zooms keep faces in frame: the crop sits a little above centre.
  if (t.zoom === "punch") return ",scale=" + even(Math.round(width * 1.12)) + ":-2,crop=" + width + ":" + height + ":(iw-ow)/2:(ih-oh)*0.4";
  if (t.zoom === "push") return ",scale=w='2*trunc(" + width + "*(1+0.08*t/" + Math.max(0.1, lengthS).toFixed(3) + ")/2)':h=-2:eval=frame,crop=" + width + ":" + height + ":(iw-ow)/2:(ih-oh)*0.4";
  return "";
}

/** The clip's look and transitions (applied after any background change). */
export function clipFinish(clips: TimelineClip[], index: number, lengthS: number): string {
  const clip = clips[index]!; const t = clip.transform ?? {};
  const parts: string[] = [];
  const look = typeof t.look === "string" ? LOOK_FILTERS[t.look] : undefined;
  if (look) parts.push(look);
  // A transition at a cut is shared: the outgoing clip fades out, the incoming one fades in (no overlap, so timing is unchanged).
  const incoming = typeof t.transitionIn === "string" ? t.transitionIn : "cut";
  const next = clips[index + 1]; const nextIn = typeof next?.transform?.transitionIn === "string" ? next.transform.transitionIn : "cut";
  const outgoing = typeof t.transitionOut === "string" && t.transitionOut !== "cut" ? t.transitionOut : nextIn === "dip-black" || nextIn === "dip-white" ? nextIn : "cut";
  const fadeIn = TRANSITION_SECONDS[incoming]; const fadeOut = TRANSITION_SECONDS[outgoing];
  if (fadeIn) parts.push("fade=t=in:st=0:d=" + Math.min(fadeIn, lengthS / 3).toFixed(3) + ":color=" + (incoming === "dip-black" ? "black" : "white"));
  if (fadeOut) { const d = Math.min(fadeOut, lengthS / 3); parts.push("fade=t=out:st=" + Math.max(0, lengthS - d).toFixed(3) + ":d=" + d.toFixed(3) + ":color=" + (outgoing === "dip-black" ? "black" : "white")); }
  return parts.length ? "," + parts.join(",") : "";
}

/** Crop to width×height after an "increase" scale, centred on the subject (clamped to the frame). */
export function coverCrop(width: number, height: number, focus: { x: number; y: number } | null): string {
  if (!focus) return "crop=" + width + ":" + height;
  const fx = Math.min(1, Math.max(0, focus.x)).toFixed(4);
  const fy = Math.min(1, Math.max(0, focus.y)).toFixed(4);
  return "crop=" + width + ":" + height + ":x='min(max(iw*" + fx + "-" + width + "/2,0),iw-" + width + ")':y='min(max(ih*" + fy + "-" + height + "/2,0),ih-" + height + ")'";
}

const BACKGROUND_KINDS = new Set(["blur", "color", "media"]);
function hexColour(value: unknown): string { return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.slice(1).toUpperCase() : "1F2A24"; }

function seconds(microseconds: number): string {
  if (!Number.isSafeInteger(microseconds) || microseconds < 0) throw new Error("Time values must be non-negative safe integers");
  return (microseconds / 1_000_000).toFixed(6);
}
function clampNumber(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : max; }
function even(value: number): number {
  if (!Number.isInteger(value) || value < 2 || value > 16_384) throw new Error("Video dimensions are invalid");
  return value % 2 === 0 ? value : value - 1;
}
function escapeFilterPath(path: string): string {
  if (path.includes("\0") || path.includes("\n") || path.includes("'")) throw new Error("Invalid caption path");
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}
