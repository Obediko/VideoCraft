#!/usr/bin/env python3
"""Face track for a whole video: where the speaker's face is, twice a second.

Usage: faces.py <video> [step_seconds]
Prints one JSON object: {"step": 0.5, "boxes": [[x0, y0, x1, y1] | null, ...]} with box edges as fractions of
the frame (0..1), one entry per step from t=0. The largest face is tracked; short gaps (under 2 s) are filled
from the neighbours, and the track is smoothed so text placed around it does not jump.
Uses OpenCV's YuNet face detector (models/face_detection_yunet_2023mar.onnx, bundled), else Haar cascades.
A detection only counts when it is seen again in a neighbouring sample, which removes one-off false hits.
"""
import json, os, sys
import cv2

MIN_FACE_FRACTION = 0.04
YUNET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "face_detection_yunet_2023mar.onnx")

def make_detector():
    if os.path.exists(YUNET) and hasattr(cv2, "FaceDetectorYN"):
        net = cv2.FaceDetectorYN.create(YUNET, "", (320, 320), 0.75, 0.3, 50)
        def yunet(frame):
            h, w = frame.shape[:2]
            scale = 640 / max(w, h) if max(w, h) > 640 else 1.0
            small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale != 1.0 else frame
            sh, sw = small.shape[:2]
            net.setInputSize((sw, sh))
            _, faces = net.detect(small)
            if faces is None or len(faces) == 0:
                return None
            fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])[:4]
            if fw / sw < MIN_FACE_FRACTION:
                return None
            # YuNet's box is brow to chin; extend it to cover hair and chin.
            return [max(0.0, (fx - fw * 0.1) / sw), max(0.0, (fy - fh * 0.3) / sh), min(1.0, (fx + fw * 1.1) / sw), min(1.0, (fy + fh * 1.1) / sh)]
        return yunet, "yunet"
    cascades = [cv2.CascadeClassifier(cv2.data.haarcascades + n) for n in ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml")]
    if any(c.empty() for c in cascades):
        raise RuntimeError("no face detector available in this OpenCV build")
    return (lambda frame: detect(cascades, frame)), "haar"

def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0

def detect(cascades, frame):
    h, w = frame.shape[:2]
    scale = 480 / w if w > 480 else 1.0
    small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale != 1.0 else frame
    plain = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    best = None
    for gray in (plain, cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(plain)):
        for c in cascades:
            for (fx, fy, fw, fh) in c.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(int(gray.shape[1] * MIN_FACE_FRACTION),) * 2):
                if best is None or fw * fh > best[2] * best[3]:
                    best = (fx, fy, fw, fh)
        if best:
            break
    if not best:
        return None
    gw, gh = plain.shape[1], plain.shape[0]
    fx, fy, fw, fh = best
    # A Haar box covers brow to chin; extend it a little to cover hair and chin.
    return [max(0.0, (fx - fw * 0.1) / gw), max(0.0, (fy - fh * 0.25) / gh), min(1.0, (fx + fw * 1.1) / gw), min(1.0, (fy + fh * 1.15) / gh)]

def main(path, step):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("cannot open video")
    detector, engine = make_detector()
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frames / fps if frames > 0 else 0
    count = min(14400, max(1, int(duration / step) + 1))
    boxes = []
    for i in range(count):
        cap.set(cv2.CAP_PROP_POS_MSEC, i * step * 1000)
        ok, frame = cap.read()
        boxes.append(detector(frame) if ok else None)
    cap.release()
    # Keep a detection only if a neighbouring sample sees a face in about the same place.
    raw = list(boxes)
    boxes = [b if b is not None and any(raw[j] is not None and iou(b, raw[j]) > 0.3 for j in (i - 1, i + 1) if 0 <= j < len(raw)) else None for i, b in enumerate(raw)]
    # Fill short gaps from the nearest detection.
    gap = int(2 / step)
    found = list(boxes)
    for i, b in enumerate(found):
        if b is None:
            for d in range(1, gap + 1):
                near = next((found[j] for j in (i - d, i + d) if 0 <= j < len(found) and found[j] is not None), None)
                if near:
                    boxes[i] = near
                    break
    # Smooth: median of each edge over a 5-sample window.
    smooth = []
    for i, b in enumerate(boxes):
        if b is None:
            smooth.append(None); continue
        window = [boxes[j] for j in range(max(0, i - 2), min(len(boxes), i + 3)) if boxes[j] is not None]
        smooth.append([round(sorted(w[k] for w in window)[len(window) // 2], 4) for k in range(4)])
    return {"step": step, "engine": engine, "boxes": smooth}

if __name__ == "__main__":
    try:
        print(json.dumps(main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 0.5)))
    except Exception as exc:
        sys.stderr.write(str(exc) + "\n"); sys.exit(1)
