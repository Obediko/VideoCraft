import type React from "react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { generateSoundEffect, type SoundEffectKind } from "../../../packages/music/src/index.js";
import { BackgroundLayer, type BackgroundSpec } from "./BackgroundLayer.js";
import { LOOK_CSS, blendAt, captionBottomFor, faceDuring, faceInFrame, focusDuring, titleTopFor, veilAt, zoomAt, type FaceTrack, type FrameBox, type PreviewClip as Clip } from "./preview.js";

/**
 * Live preview of the edit in the browser: plays the cut clip by clip and draws captions, titles, cutaways,
 * the progress bar, zooms, looks and transitions over it. It approximates the export (which FFmpeg renders
 * exactly), so changes show at once without rendering.
 */
type Track = { id: string; kind: string; clips: Clip[] };
export type LivePreviewHandle = { seek(timelineUs: number): void; pause(): void; play(): void; setMuted(muted: boolean): void };
type Props = {
  tracks: Track[];
  durationUs: number;
  urls: Record<string, string>;
  /** Shape of the output frame and how the footage fills it. */
  shape: "tall" | "wide" | "square";
  fit: "cover" | "contain";
  /** Output size (for the crop maths) and caption style, so text sits where the export puts it. */
  output?: { width: number; height: number };
  captionStyle?: string;
  /** The speaker's face per video asset, and each asset's picture size: captions and text stay off the face. */
  faces?: Record<string, FaceTrack>;
  sizes?: Record<string, { width: number; height: number }>;
  /** Preview mattes (person cut-outs) per video asset, and which assets are photos: for backgrounds and cutaways behind the person. */
  mattes?: Record<string, string>;
  stills?: Record<string, boolean>;
  onTime?(timelineUs: number): void;
};

export const LivePreview = forwardRef<LivePreviewHandle, Props>(function LivePreview({ tracks, durationUs, urls, shape, fit, output, captionStyle = "bold-pop", faces, sizes, mattes, stills, onTime }, ref) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const snapRef = useRef<HTMLCanvasElement | null>(null);
  const snapFor = useRef(-1);
  const music = useRef<HTMLAudioElement | null>(null);
  const [tUs, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const clips = useMemo(() => [...(tracks.find((t) => t.kind === "video")?.clips ?? [])].sort((a, b) => a.timelineStartUs - b.timelineStartUs), [tracks]);
  const overlays = tracks.filter((t) => t.kind === "overlay").flatMap((t) => t.clips);
  const cues = tracks.filter((t) => t.kind === "caption").flatMap((t) => t.clips);
  const musicClip = tracks.find((t) => t.kind === "audio")?.clips.find((c) => c.transform?.role === "music");
  const voiceovers = tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips).filter((c) => c.transform?.role === "voiceover");
  const voiceEls = useRef<Record<string, HTMLAudioElement | null>>({});
  const sfx = tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips).filter((c) => c.transform?.role === "sfx");
  const audioCtx = useRef<AudioContext | null>(null);
  const sfxBuffers = useRef<Record<string, AudioBuffer>>({});
  const lastSfxT = useRef(0);
  const indexRef = useRef(0);
  const tRef = useRef(0);
  const clipAt = (t: number) => Math.max(0, clips.findIndex((c) => t >= c.timelineStartUs && t < c.timelineEndUs) === -1 ? (t >= durationUs ? clips.length - 1 : 0) : clips.findIndex((c) => t >= c.timelineStartUs && t < c.timelineEndUs));
  const report = (t: number) => { tRef.current = t; setT(t); onTime?.(t); };

  function load(index: number, localUs: number, thenPlay: boolean) {
    const clip = clips[index]; const el = video.current;
    if (!clip || !el) return;
    indexRef.current = index;
    const url = urls[clip.assetId];
    if (url && el.dataset.src !== url) { el.dataset.src = url; el.src = url; }
    const at = (clip.sourceStartUs + localUs) / 1e6;
    const go = () => { el.currentTime = at; if (thenPlay) void el.play().catch(() => setPlaying(false)); };
    if (el.readyState >= 1) go(); else el.addEventListener("loadedmetadata", go, { once: true });
  }
  function seek(t: number) {
    const clamped = Math.max(0, Math.min(durationUs, t));
    const i = clipAt(clamped); const clip = clips[i];
    if (clip) load(i, Math.max(0, clamped - clip.timelineStartUs), playing);
    if (music.current && musicClip) music.current.currentTime = (clamped / 1e6) % Math.max(1, music.current.duration || 1);
    report(clamped);
  }
  useImperativeHandle(ref, () => ({ seek, pause: () => { video.current?.pause(); music.current?.pause(); setPlaying(false); }, play: () => { if (!playing) toggle(); }, setMuted: (muted: boolean) => { if (video.current) video.current.muted = muted; if (music.current) music.current.muted = muted; } }));

  // Keep the picture on the right frame when the edit changes.
  useEffect(() => { if (!playing) seek(tRef.current); }, [clips, urls]);

  // Sound effects play when the playhead reaches them, at their own volume (made in the browser, like the export's).
  useEffect(() => {
    const previous = lastSfxT.current; lastSfxT.current = tUs;
    if (!playing || tUs < previous || tUs - previous > 400_000) return;
    for (const clip of sfx) {
      if (clip.timelineStartUs <= previous || clip.timelineStartUs > tUs) continue;
      const kind = String(clip.transform?.kind ?? "pop") as SoundEffectKind;
      try {
        const ctx = audioCtx.current ?? (audioCtx.current = new AudioContext());
        let buffer = sfxBuffers.current[kind];
        if (!buffer) { const fx = generateSoundEffect(kind, ctx.sampleRate); buffer = ctx.createBuffer(2, fx.left.length, fx.sampleRate); buffer.copyToChannel(fx.left as Float32Array<ArrayBuffer>, 0); buffer.copyToChannel(fx.right as Float32Array<ArrayBuffer>, 1); sfxBuffers.current[kind] = buffer; }
        const source = ctx.createBufferSource(); source.buffer = buffer;
        const gain = ctx.createGain(); gain.gain.value = Math.pow(10, Number(clip.transform?.volumeDb ?? -18) / 20);
        source.connect(gain).connect(ctx.destination); source.start();
      } catch { /* no audio output */ }
    }
  }, [tUs, playing]);

  // Voice-overs play at their moments; the footage and music dip under them, as in the export.
  useEffect(() => {
    let ducked = false;
    for (const vo of voiceovers) {
      const el = voiceEls.current[vo.id]; if (!el) continue;
      const inside = tUs >= vo.timelineStartUs && tUs < vo.timelineEndUs;
      if (inside && vo.transform?.duck !== false) ducked = true;
      if (inside && playing) {
        const at = (vo.sourceStartUs + tUs - vo.timelineStartUs) / 1e6;
        if (Math.abs(el.currentTime - at) > 0.25) el.currentTime = at;
        el.volume = Math.min(1, Math.pow(10, Number(vo.transform?.volumeDb ?? 0) / 20));
        if (el.paused) void el.play().catch(() => undefined);
      } else if (!el.paused) el.pause();
    }
    if (video.current) video.current.volume = ducked ? 0.2 : 1;
    if (music.current && musicClip) music.current.volume = Math.min(1, Math.pow(10, Number(musicClip.transform?.volumeDb ?? -16) / 20) * 1.6) * (ducked ? 0.2 : 1);
  }, [tUs, playing]);

  // While playing, follow the video and jump to the next clip at each cut.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const el = video.current; const clip = clips[indexRef.current];
      if (el && clip) {
        const sourceUs = el.currentTime * 1e6;
        if (sourceUs >= clip.sourceEndUs - 20_000 || el.ended) {
          const next = indexRef.current + 1;
          if (next >= clips.length) { el.pause(); music.current?.pause(); setPlaying(false); report(durationUs); return; }
          // A blend into the next clip shows this clip's last frame over the start of the next, as the export overlaps them.
          const snap = snapRef.current;
          if (snap && el.videoWidth && blendAt(clips, clips[next]!.timelineStartUs + 1)) {
            snap.width = el.videoWidth; snap.height = el.videoHeight;
            try { snap.getContext("2d")?.drawImage(el, 0, 0, snap.width, snap.height); snapFor.current = next; } catch { snapFor.current = -1; }
          }
          load(next, 0, true);
          report(clips[next]!.timelineStartUs);
        } else if (sourceUs >= clip.sourceStartUs - 50_000) {
          report(clip.timelineStartUs + Math.max(0, sourceUs - clip.sourceStartUs));
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, clips]);

  function toggle() {
    const el = video.current; if (!el) return;
    if (playing) { el.pause(); music.current?.pause(); setPlaying(false); return; }
    const start = tRef.current >= durationUs - 50_000 ? 0 : tRef.current;
    const i = clipAt(start); const clip = clips[i];
    if (!clip) return;
    setPlaying(true);
    load(i, Math.max(0, start - clip.timelineStartUs), true);
    if (music.current && musicClip) { music.current.volume = Math.min(1, Math.pow(10, Number(musicClip.transform?.volumeDb ?? -16) / 20) * 1.6); void music.current.play().catch(() => undefined); }
    report(start);
  }

  const current = clips[clipAt(tUs)];
  const look = current ? LOOK_CSS[String(current.transform?.look ?? "")] : undefined;
  const zoom = zoomAt(current, tUs);
  const veil = veilAt(clips, tUs, durationUs);
  const blend = blendAt(clips, tUs);
  const blendStyle = ((): React.CSSProperties | undefined => {
    if (!blend || blend.index !== snapFor.current) return undefined;
    const p = Math.min(1, Math.max(0, blend.progress));
    const base: React.CSSProperties = { objectFit: fit, ...(look ? { filter: look } : {}) };
    if (blend.kind === "dissolve") return { ...base, opacity: 1 - p };
    if (blend.kind === "push") return { ...base, transform: "translateX(" + (-p * 100).toFixed(2) + "%)" };
    if (blend.kind === "slide-up") return { ...base, transform: "translateY(" + (-p * 100).toFixed(2) + "%)" };
    if (blend.kind === "wipe") return { ...base, clipPath: "inset(0 " + (p * 100).toFixed(2) + "% 0 0)" };
    if (blend.kind === "circle") { const mask = "radial-gradient(circle at 50% 50%, transparent " + (p * 75).toFixed(1) + "%, #000 " + (p * 75 + 1).toFixed(1) + "%)"; return { ...base, maskImage: mask, WebkitMaskImage: mask }; }
    if (blend.kind === "blur") return { ...base, opacity: 1 - p, filter: (look ? look + " " : "") + "blur(" + (p * 16).toFixed(1) + "px)" };
    return undefined;
  })();
  const cue = cues.find((c) => tUs >= c.timelineStartUs && tUs < c.timelineEndUs);
  const cueWords = cue ? String(cue.transform?.text ?? "").split(/\s+/).filter(Boolean) : [];
  const timings = typeof cue?.transform?.wordDurationsCs === "string" ? cue.transform.wordDurationsCs.split(",").map(Number) : [];
  let activeWord = -1;
  if (cue && timings.length === cueWords.length) { let acc = cue.timelineStartUs; for (let i = 0; i < timings.length; i += 1) { acc += timings[i]! * 10_000; if (tUs < acc) { activeWord = i; break; } } }
  const graphics = overlays.filter((c) => c.transform?.role === "graphic" && tUs >= c.timelineStartUs && tUs < c.timelineEndUs);
  const broll = overlays.filter((c) => c.transform?.role === "broll" && tUs >= c.timelineStartUs && tUs < c.timelineEndUs);
  const progress = overlays.find((c) => c.transform?.role === "progress");
  const musicUrl = musicClip ? urls[musicClip.assetId] : undefined;
  // Where the face is on screen during a stretch of the edit (fractions of the frame), as the export works it out.
  const out = output ?? (shape === "tall" ? { width: 1080, height: 1920 } : shape === "square" ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 });
  const focusOf = (clip: Clip) => {
    const manualX = Number(clip.transform?.focusX); const manualY = Number(clip.transform?.focusY);
    return Number.isFinite(manualX) && Number.isFinite(manualY) && clip.transform?.focusX !== undefined ? { x: manualX, y: manualY } : focusDuring(faces?.[clip.assetId], clip.sourceStartUs, clip.sourceEndUs);
  };
  const faceOver = (startUs: number, endUs: number): FrameBox | undefined => {
    let u: FrameBox | undefined;
    for (const clip of clips) {
      const from = Math.max(startUs, clip.timelineStartUs); const to = Math.min(endUs, clip.timelineEndUs);
      const size = sizes?.[clip.assetId];
      if (to <= from || !size) continue;
      const box = faceDuring(faces?.[clip.assetId], clip.sourceStartUs + from - clip.timelineStartUs, clip.sourceStartUs + to - clip.timelineStartUs);
      const zooms = clip.transform?.zoom === "punch" ? [1.12] : clip.transform?.zoom === "push" ? [1, 1.08] : [1];
      for (const z of zooms) {
        const b = box ? faceInFrame(box, size, out, fit, fit === "cover" ? focusOf(clip) : null, z) : undefined;
        if (b) u = u ? { x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) } : b;
      }
    }
    return u;
  };
  const captionBottom = cue ? captionBottomFor(faceOver(cue.timelineStartUs, cue.timelineEndUs), captionStyle) : 0;
  const captionTop = cue ? 1 - captionBottom - 0.13 : undefined;
  const currentFocus = current && fit === "cover" ? focusOf(current) : null;
  // A changed background on this clip, or a cutaway placed behind the person, is drawn on a canvas with the matte.
  const behindNow = broll.find((c) => c.transform?.mode === "behind");
  const bgKind = String(current?.transform?.background ?? "none");
  const background: BackgroundSpec | undefined = behindNow ? { kind: "media", ...(urls[behindNow.assetId] ? { url: urls[behindNow.assetId]! } : {}), still: stills?.[behindNow.assetId] ?? true }
    : bgKind === "blur" ? { kind: "blur" } : bgKind === "color" ? { kind: "color", color: String(current?.transform?.backgroundColor ?? "#1F2A24") }
    : bgKind === "media" && typeof current?.transform?.backgroundAssetId === "string" ? { kind: "media", ...(urls[current.transform.backgroundAssetId] ? { url: urls[current.transform.backgroundAssetId]! } : {}), still: stills?.[current.transform.backgroundAssetId] ?? true } : undefined;
  const matteUrl = current ? mattes?.[current.assetId] : undefined;
  const compositing = Boolean(background && matteUrl && videoEl);
  const fmt = (us: number) => { const s = us / 1e6; return Math.floor(s / 60) + ":" + (s % 60).toFixed(1).padStart(4, "0"); };

  return <div className="live">
    <div className={"live-frame " + shape} aria-label="Live preview of the edit">
      <video ref={(el) => { video.current = el; if (el !== videoEl) setVideoEl(el); }} className="live-video" muted={false} playsInline preload="auto" style={{ objectFit: fit, ...(currentFocus ? { objectPosition: (currentFocus.x * 100).toFixed(1) + "% " + (currentFocus.y * 100).toFixed(1) + "%" } : {}), transform: zoom !== 1 ? "scale(" + zoom.toFixed(4) + ")" : undefined, transformOrigin: "50% 40%", filter: look, ...(compositing ? { opacity: 0 } : {}) }} />
      {compositing && <BackgroundLayer video={videoEl} matteUrl={matteUrl!} spec={background!} fit={fit} focus={currentFocus} zoom={zoom} filter={look} />}
      <canvas ref={snapRef} className="live-snap" aria-hidden="true" style={blendStyle ?? { display: "none" }} />
      {background && !matteUrl && <span className="live-note">Cutting you out for the preview…</span>}
      {!urls[current?.assetId ?? ""] && <span className="live-empty">Preparing the footage…</span>}
      {broll.filter((c) => !(c.transform?.mode === "behind" && compositing)).map((c) => { const url = urls[c.assetId]; const pip = c.transform?.mode === "pip"; return url ? <img key={c.id} className={"live-broll" + (pip ? " pip" : "")} src={url} alt="" /> : <span key={c.id} className={"live-broll placeholder" + (pip ? " pip" : "")}>Cutaway</span>; })}
      {progress && <span className="live-progress" style={{ width: (100 * tUs) / Math.max(1, durationUs) + "%", background: String(progress.transform?.color ?? "#A8C49A") }} />}
      {graphics.map((g) => { const kind = String(g.transform?.kind ?? "title"); const pos = String(g.transform?.position ?? (kind === "lower-third" ? "bottom" : "center")); const color = String(g.transform?.color ?? "#A8C49A");
        const face = faceOver(g.timelineStartUs, g.timelineEndUs);
        let lowerBottom = 0.22;
        if (kind === "lower-third" && face && face.x0 < 0.6 && 1 - lowerBottom > face.y0 - 0.02 && 1 - lowerBottom - 0.12 < face.y1 + 0.02) {
          const below = 1 - (face.y1 + 0.02 + 0.12); const above = 1 - (face.y0 - 0.02);
          lowerBottom = below >= (captionTop !== undefined ? 1 - captionTop + 0.02 : 0.06) ? below : face.y0 - 0.14 >= 0.06 ? above : lowerBottom;
        }
        const titleTop = kind === "lower-third" ? 0 : titleTopFor(pos, face, captionTop);
        return kind === "lower-third"
          ? <div key={g.id} className="live-lower" style={{ bottom: (lowerBottom * 100).toFixed(1) + "%" }}><span className="bar" style={{ background: color }} /><span className="text"><strong>{String(g.transform?.text ?? "")}</strong>{g.transform?.subtitle ? <span>{String(g.transform.subtitle)}</span> : null}</span></div>
          : <div key={g.id} className={"live-title " + kind} style={{ top: (titleTop * 100).toFixed(1) + "%", ...(kind === "title" ? { borderColor: color } : { background: color }) }}><strong>{String(g.transform?.text ?? "")}</strong>{kind === "title" && g.transform?.subtitle ? <span>{String(g.transform.subtitle)}</span> : null}</div>; })}
      {cue && <div className={"live-caption " + captionStyle} style={{ bottom: (captionBottom * 100).toFixed(1) + "%" }}>{cueWords.map((w, i) => <span key={i} className={i === activeWord ? "on" : ""}>{w} </span>)}</div>}
      {veil.opacity > 0 && <span className="live-veil" style={{ opacity: veil.opacity, background: veil.color }} />}
    </div>
    {musicUrl && <audio ref={music} src={musicUrl} loop preload="auto" />}
    {voiceovers.map((vo) => urls[vo.assetId] ? <audio key={vo.id} ref={(el) => { voiceEls.current[vo.id] = el; }} src={urls[vo.assetId]} preload="auto" /> : null)}
    <div className="live-controls">
      <button type="button" className="btn icon" aria-label={playing ? "Pause" : "Play the edit"} onClick={toggle} disabled={clips.length === 0}>{playing ? "❚❚" : "▶"}</button>
      <input type="range" aria-label="Position in the edit" min={0} max={Math.max(1, Math.round(durationUs / 1000))} step={50} value={Math.round(tUs / 1000)} onChange={(event) => seek(Number(event.target.value) * 1000)} />
      <span className="mono small">{fmt(tUs)} / {fmt(durationUs)}</span>
    </div>
    <p className="muted small">Live preview: close to the export; the export renders every frame exactly.</p>
  </div>;
});
