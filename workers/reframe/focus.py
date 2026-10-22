#!/usr/bin/env python3
"""Subject-focus detector for face-aware reframing.

Usage: focus.py <video> <start_seconds> <end_seconds>
Prints one JSON object: {"x": 0..1, "y": 0..1, "confidence": 0..1, "samples": n}
x/y is the median centre of the largest face over sampled frames, as a fraction of the frame.
confidence is the share of sampled frames in which a face was found. When nothing is found the
object is {"x": null, "y": null, "confidence": 0, "samples": n} and callers fall back to centre.
Uses OpenCV's bundled Haar cascades, so no model download is needed.
"""
import json, statistics, sys
import cv2

MAX_SAMPLES = 14
MIN_FACE_FRACTION = 0.04  # ignore detections narrower than 4% of the frame width

def main(path, start, end):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("cannot open video")
    cascades = [cv2.CascadeClassifier(cv2.data.haarcascades + n) for n in ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml")]
    if any(c.empty() for c in cascades):
        # OpenCV 5.x wheels ship without the cascade files; requirements pin opencv<5.
        raise RuntimeError("Haar cascades are missing from this OpenCV build (use opencv-python-headless<5)")
    span = max(end - start, 0.1)
    count = max(1, min(MAX_SAMPLES, int(span * 2)))
    xs, ys, hits = [], [], 0
    for i in range(count):
        t = start + span * (i + 0.5) / count
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        h, w = frame.shape[:2]
        scale = 640 / w if w > 640 else 1.0
        small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale != 1.0 else frame
        plain = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        best = None
        # Plain grayscale first; global equalisation hurts frames with large dark areas, so the
        # fallback uses local contrast (CLAHE) for dim or flat footage.
        for gray in (plain, cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(plain)):
            for c in cascades:
                for (fx, fy, fw, fh) in c.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(int(gray.shape[1] * MIN_FACE_FRACTION),) * 2):
                    if best is None or fw * fh > best[2] * best[3]:
                        best = (fx, fy, fw, fh)
            if best:
                break
        if best:
            hits += 1
            xs.append((best[0] + best[2] / 2) / gray.shape[1])
            ys.append((best[1] + best[3] / 2) / gray.shape[0])
    cap.release()
    if not xs:
        return {"x": None, "y": None, "confidence": 0, "samples": count}
    return {"x": round(statistics.median(xs), 4), "y": round(statistics.median(ys), 4), "confidence": round(hits / count, 3), "samples": count}

if __name__ == "__main__":
    try:
        print(json.dumps(main(sys.argv[1], float(sys.argv[2]), float(sys.argv[3]))))
    except Exception as exc:
        sys.stderr.write(str(exc) + "\n"); sys.exit(1)
