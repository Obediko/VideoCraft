import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { LOOK_CSS, veilAt, zoomAt, type PreviewClip as Clip } from "./preview.js";

/**
 * Live preview of the edit in the browser: plays the cut clip by clip and draws captions, titles, cutaways,
 * the progress bar, zooms, looks and transitions over it. It approximates the export (which FFmpeg renders
 * exactly), so changes show at once without rendering.
 */
type Track = { id: string; kind: string; clips: Clip[] };
export type LivePreviewHandle = { seek(timelineUs: number): void; pause(): void };
type Props = {
  tracks: Track[];
  durationUs: number;
  urls: Record<string, string>;
  /** Shape of the output frame and how the footage fills it. */
  shape: "tall" | "wide" | "square";
  fit: "cover" | "contain";
  onTime?(timelineUs: number): void;
};

export const LivePreview = forwardRef<LivePreviewHandle, Props>(function LivePreview({ tracks, durationUs, urls, shape, fit, onTime }, ref) {
  const video = useRef<HTMLVideoElement | null>(null);
  const music = useRef<HTMLAudioElement | null>(null);
  const [tUs, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const clips = useMemo(() => [...(tracks.find((t) => t.kind === "video")?.clips ?? [])].sort((a, b) => a.timelineStartUs - b.timelineStartUs), [tracks]);
  const overlays = tracks.filter((t) => t.kind === "overlay").flatMap((t) => t.clips);
  const cues = tracks.filter((t) => t.kind === "caption").flatMap((t) => t.clips);
  const musicClip = tracks.find((t) => t.kind === "audio")?.clips.find((c) => c.transform?.role === "music");
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
  useImperativeHandle(ref, () => ({ seek, pause: () => { video.current?.pause(); music.current?.pause(); setPlaying(false); } }));

  // Keep the picture on the right frame when the edit changes.
  useEffect(() => { if (!playing) seek(tRef.current); }, [clips, urls]);

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
  const cue = cues.find((c) => tUs >= c.timelineStartUs && tUs < c.timelineEndUs);
  const cueWords = cue ? String(cue.transform?.text ?? "").split(/\s+/).filter(Boolean) : [];
  const timings = typeof cue?.transform?.wordDurationsCs === "string" ? cue.transform.wordDurationsCs.split(",").map(Number) : [];
  let activeWord = -1;
  if (cue && timings.length === cueWords.length) { let acc = cue.timelineStartUs; for (let i = 0; i < timings.length; i += 1) { acc += timings[i]! * 10_000; if (tUs < acc) { activeWord = i; break; } } }
  const graphics = overlays.filter((c) => c.transform?.role === "graphic" && tUs >= c.timelineStartUs && tUs < c.timelineEndUs);
  const broll = overlays.filter((c) => c.transform?.role === "broll" && tUs >= c.timelineStartUs && tUs < c.timelineEndUs);
  const progress = overlays.find((c) => c.transform?.role === "progress");
  const musicUrl = musicClip ? urls[musicClip.assetId] : undefined;
  const fmt = (us: number) => { const s = us / 1e6; return Math.floor(s / 60) + ":" + (s % 60).toFixed(1).padStart(4, "0"); };

  return <div className="live">
    <div className={"live-frame " + shape} aria-label="Live preview of the edit">
      <video ref={video} className="live-video" muted={false} playsInline preload="auto" style={{ objectFit: fit, transform: zoom !== 1 ? "scale(" + zoom.toFixed(4) + ")" : undefined, transformOrigin: "50% 40%", filter: look }} />
      {!urls[current?.assetId ?? ""] && <span className="live-empty">Preparing the footage…</span>}
      {broll.map((c) => { const url = urls[c.assetId]; const pip = c.transform?.mode === "pip"; return url ? <img key={c.id} className={"live-broll" + (pip ? " pip" : "")} src={url} alt="" /> : <span key={c.id} className={"live-broll placeholder" + (pip ? " pip" : "")}>Cutaway</span>; })}
      {progress && <span className="live-progress" style={{ width: (100 * tUs) / Math.max(1, durationUs) + "%", background: String(progress.transform?.color ?? "#A8C49A") }} />}
      {graphics.map((g) => { const kind = String(g.transform?.kind ?? "title"); const pos = String(g.transform?.position ?? (kind === "lower-third" ? "bottom" : "center")); const color = String(g.transform?.color ?? "#A8C49A");
        return kind === "lower-third"
          ? <div key={g.id} className="live-lower"><span className="bar" style={{ background: color }} /><span className="text"><strong>{String(g.transform?.text ?? "")}</strong>{g.transform?.subtitle ? <span>{String(g.transform.subtitle)}</span> : null}</span></div>
          : <div key={g.id} className={"live-title " + kind + " " + pos} style={kind === "title" ? { borderColor: color } : { background: color }}><strong>{String(g.transform?.text ?? "")}</strong>{kind === "title" && g.transform?.subtitle ? <span>{String(g.transform.subtitle)}</span> : null}</div>; })}
      {cue && <div className="live-caption">{cueWords.map((w, i) => <span key={i} className={i === activeWord ? "on" : ""}>{w} </span>)}</div>}
      {veil.opacity > 0 && <span className="live-veil" style={{ opacity: veil.opacity, background: veil.color }} />}
    </div>
    {musicUrl && <audio ref={music} src={musicUrl} loop preload="auto" />}
    <div className="live-controls">
      <button type="button" className="btn icon" aria-label={playing ? "Pause" : "Play the edit"} onClick={toggle} disabled={clips.length === 0}>{playing ? "❚❚" : "▶"}</button>
      <input type="range" aria-label="Position in the edit" min={0} max={Math.max(1, Math.round(durationUs / 1000))} step={50} value={Math.round(tUs / 1000)} onChange={(event) => seek(Number(event.target.value) * 1000)} />
      <span className="mono small">{fmt(tUs)} / {fmt(durationUs)}</span>
    </div>
    <p className="muted small">Live preview: close to the export; the export renders every frame exactly.</p>
  </div>;
});
