import { useEffect, useRef } from "react";

/**
 * Live preview of a changed background: draws what is behind the person (the picture blurred, a colour, or a photo
 * or clip) and then the person on top, cut out with the preview matte (a greyscale video in step with the footage).
 * The luma-to-alpha step is an SVG colour-matrix filter on the canvas, so no pixels are read back (works with
 * media from other origins).
 */
export type BackgroundSpec = { kind: "blur" | "color" | "media"; color?: string; url?: string; still?: boolean };
type Props = {
  video: HTMLVideoElement | null;
  matteUrl: string;
  spec: BackgroundSpec;
  fit: "cover" | "contain";
  focus: { x: number; y: number } | null;
  zoom: number;
  filter?: string | undefined;
  onError?(): void;
};

/** Where a source of size sw×sh lands in a W×H frame (object-fit plus object-position, then the zoom). */
export function fitted(sw: number, sh: number, W: number, H: number, fit: "cover" | "contain", focus: { x: number; y: number } | null, zoom = 1): { x: number; y: number; w: number; h: number } {
  const s = fit === "cover" ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const w = sw * s; const h = sh * s;
  const fx = focus?.x ?? 0.5; const fy = focus?.y ?? 0.5;
  let x = fit === "cover" ? -Math.min(Math.max(w * fx - W / 2, 0), w - W) : (W - w) / 2;
  let y = fit === "cover" ? -Math.min(Math.max(h * fy - H / 2, 0), h - H) : (H - h) / 2;
  // Zoom about (50%, 40%), as the preview's CSS transform and the export's crop do.
  x = W * 0.5 + (x - W * 0.5) * zoom; y = H * 0.4 + (y - H * 0.4) * zoom;
  return { x, y, w: w * zoom, h: h * zoom };
}

export function BackgroundLayer({ video, matteUrl, spec, fit, focus, zoom, filter, onError }: Props) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const matte = useRef<HTMLVideoElement | null>(null);
  const backdrop = useRef<HTMLVideoElement | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const state = useRef({ spec, fit, focus, zoom });
  state.current = { spec, fit, focus, zoom };

  useEffect(() => {
    if (spec.kind === "media" && spec.url && spec.still) { const img = new Image(); img.src = spec.url; image.current = img; }
    else image.current = null;
  }, [spec.kind, spec.url, spec.still]);

  useEffect(() => {
    let frame = 0;
    const off = document.createElement("canvas");
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const el = video; const m = matte.current; const c = canvas.current;
      if (!el || !m || !c || el.readyState < 2) return;
      // Keep the matte on the footage's frame.
      if (Math.abs(m.currentTime - el.currentTime) > (el.paused ? 0.01 : 0.12)) m.currentTime = el.currentTime;
      if (!el.paused && m.paused) void m.play().catch(() => undefined);
      if (el.paused && !m.paused) m.pause();
      const W = Math.round(c.clientWidth * Math.min(2, window.devicePixelRatio || 1)); const H = Math.round(c.clientHeight * Math.min(2, window.devicePixelRatio || 1));
      if (!W || !H) return;
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; off.width = W; off.height = H; }
      const ctx = c.getContext("2d"); const o = off.getContext("2d");
      if (!ctx || !o) return;
      const { spec: s, fit: f, focus: p, zoom: z } = state.current;
      const box = fitted(el.videoWidth || 16, el.videoHeight || 9, W, H, f, p, z);
      ctx.save(); ctx.clearRect(0, 0, W, H);
      if (s.kind === "blur") { ctx.filter = "blur(" + Math.round(W / 40) + "px)"; const cover = fitted(el.videoWidth || 16, el.videoHeight || 9, W, H, "cover", p, z * 1.05); ctx.drawImage(el, cover.x, cover.y, cover.w, cover.h); ctx.filter = "none"; }
      else if (s.kind === "color") { ctx.fillStyle = s.color ?? "#1F2A24"; ctx.fillRect(0, 0, W, H); }
      else {
        const source: CanvasImageSource | null = s.still ? image.current : backdrop.current;
        const sw = s.still ? image.current?.naturalWidth ?? 0 : backdrop.current?.videoWidth ?? 0; const sh = s.still ? image.current?.naturalHeight ?? 0 : backdrop.current?.videoHeight ?? 0;
        if (source && sw && sh) { const b = fitted(sw, sh, W, H, "cover", null); ctx.drawImage(source, b.x, b.y, b.w, b.h); } else { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); }
      }
      ctx.restore();
      // The person: the footage, kept only where the matte is white.
      if (m.readyState >= 2) {
        o.save(); o.clearRect(0, 0, W, H);
        o.drawImage(el, box.x, box.y, box.w, box.h);
        o.globalCompositeOperation = "destination-in"; o.filter = "url(#vc-luma-alpha)";
        o.drawImage(m, box.x, box.y, box.w, box.h);
        o.restore();
        ctx.drawImage(off, 0, 0);
      } else ctx.drawImage(el, box.x, box.y, box.w, box.h);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [video]);

  return <>
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true"><filter id="vc-luma-alpha" colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" /></filter></svg>
    <canvas ref={canvas} className="live-composite" style={filter ? { filter } : undefined} aria-hidden="true" />
    <video ref={matte} src={matteUrl} onError={onError} muted playsInline preload="auto" style={{ display: "none" }} />
    {spec.kind === "media" && spec.url && !spec.still && <video ref={backdrop} src={spec.url} muted playsInline loop autoPlay preload="auto" style={{ display: "none" }} />}
  </>;
}
