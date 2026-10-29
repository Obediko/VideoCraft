#!/usr/bin/env python3
"""Person matte for a stretch of video: white where the person is, black behind them, soft at the edges.

Usage: matte.py <video> <start_seconds> <end_seconds> <out.mp4> [grow_px] [feather_px] [max_side]
Writes a greyscale H.264 video (the matte in the luma plane) covering [start, end) at the source frame rate,
sized like the source (long side at most max_side, default 1280). The renderer frames it exactly like the clip and uses it as alpha.

Per frame: MediaPipe's selfie segmentation (bundled model, read by OpenCV), refined with a guided filter so the
edge follows hair and shoulders, smoothed over time against flicker, then grown or shrunk and feathered.
Prints {"frames": n, "fps": f, "width": w, "height": h} on success.
"""
import json, os, subprocess, sys
import cv2
import numpy as np

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "selfie_segmentation.tflite")
FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")

def guided_filter(guide, src, radius, eps):
    """He et al.'s guided filter (grey guide), with box filters: edges of `src` snap to edges in `guide`."""
    box = lambda x: cv2.boxFilter(x, cv2.CV_32F, (radius, radius))
    mean_i = box(guide); mean_p = box(src)
    cov_ip = box(guide * src) - mean_i * mean_p
    var_i = box(guide * guide) - mean_i * mean_i
    a = cov_ip / (var_i + eps); b = mean_p - a * mean_i
    return box(a) * guide + box(b)

def main(path, start, end, out, grow, feather, max_side=1280):
    net = cv2.dnn.readNetFromTFLite(MODEL)
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("cannot open video")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    ok, frame = cap.read()
    if not ok:
        raise RuntimeError("no frames in range")
    h, w = frame.shape[:2]
    scale = min(1.0, max_side / max(w, h))
    ow, oh = max(2, int(w * scale) // 2 * 2), max(2, int(h * scale) // 2 * 2)
    count = max(1, int(round((end - start) * fps)))
    enc = subprocess.Popen([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{ow}x{oh}", "-r", repr(fps), "-i", "-",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    previous = None
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * abs(grow) + 1,) * 2) if grow else None
    written = 0
    try:
        while written < count and ok:
            small = cv2.resize(frame, (ow, oh), interpolation=cv2.INTER_AREA) if (ow, oh) != (w, h) else frame
            net.setInput(cv2.dnn.blobFromImage(cv2.resize(small, (256, 256), interpolation=cv2.INTER_AREA), 1 / 255.0, (256, 256), swapRB=True))
            mask = cv2.resize(net.forward().reshape(256, 256).astype(np.float32), (ow, oh), interpolation=cv2.INTER_LINEAR)
            guide = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
            mask = np.clip(guided_filter(guide, mask, max(4, ow // 80), 1e-3), 0, 1)
            # Against flicker: lean on the previous frame where the change is small, follow quickly where it is large.
            if previous is not None:
                weight = np.clip(np.abs(mask - previous) * 4, 0.35, 1.0)
                mask = previous + (mask - previous) * weight
            previous = mask
            out_mask = mask
            if kernel is not None:
                out_mask = cv2.dilate(out_mask, kernel) if grow > 0 else cv2.erode(out_mask, kernel)
            if feather > 0:
                k = 2 * feather + 1
                out_mask = cv2.GaussianBlur(out_mask, (k, k), 0)
            # Sharpen the transition a little so the background does not show through the body.
            out_mask = np.clip((out_mask - 0.15) / 0.7, 0, 1)
            enc.stdin.write((out_mask * 255).astype(np.uint8).tobytes())
            written += 1
            ok, frame = cap.read()
        # Short tail (the range ran past the last frame): repeat the last matte so lengths line up.
        last = (out_mask * 255).astype(np.uint8).tobytes() if written else bytes(ow * oh)
        while written < count:
            enc.stdin.write(last); written += 1
    finally:
        cap.release()
        enc.stdin.close()
        code = enc.wait()
    if code != 0:
        raise RuntimeError("matte encoding failed")
    return {"frames": written, "fps": fps, "width": ow, "height": oh}

if __name__ == "__main__":
    try:
        args = sys.argv[1:]
        print(json.dumps(main(args[0], float(args[1]), float(args[2]), args[3], int(args[4]) if len(args) > 4 else 0, int(args[5]) if len(args) > 5 else 2, int(args[6]) if len(args) > 6 else 1280)))
    except Exception as exc:
        sys.stderr.write(str(exc) + "\n"); sys.exit(1)
