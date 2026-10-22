#!/usr/bin/env python3
"""Test-only stand-in for workers/transcription/worker.py with the same JSON-lines protocol.

The production worker uses faster-whisper, whose weights are hosted on Hugging Face. This
shim uses an offline sherpa-onnx streaming transducer so the pipeline can be exercised where
Hugging Face is unreachable. It emits the same normalized segments (word timestamps, in µs).
Set SHERPA_ASR_DIR to an extracted sherpa-onnx streaming-zipformer model directory.
"""
import json, os, subprocess, sys
import numpy as np
import sherpa_onnx

d = os.environ["SHERPA_ASR_DIR"]
recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=os.path.join(d, "tokens.txt"), encoder=os.path.join(d, "encoder-epoch-99-avg-1.int8.onnx"),
    decoder=os.path.join(d, "decoder-epoch-99-avg-1.onnx"), joiner=os.path.join(d, "joiner-epoch-99-avg-1.int8.onnx"),
    num_threads=2, sample_rate=16000, feature_dim=80, decoding_method="greedy_search")
PAUSE_SPLIT_S = 0.3  # natural sentence gaps; the production worker punctuates instead

def decode(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], check=True, capture_output=True).stdout
    samples = np.frombuffer(raw, dtype=np.float32)
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    stream.accept_waveform(16000, np.zeros(16000, dtype=np.float32))
    stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    result = recognizer.get_result_all(stream)
    return list(result.tokens), list(result.timestamps)

def to_words(tokens, stamps):
    words = []
    for tok, ts in zip(tokens, stamps):
        # This model marks word starts with a leading space; SentencePiece-style models use U+2581.
        if tok.startswith((" ", chr(0x2581))) or not words:
            words.append({"text": tok.replace(chr(0x2581), "").strip(), "start": ts, "last": ts})
        else:
            words[-1]["text"] += tok; words[-1]["last"] = ts
    out = []
    for i, w in enumerate(words):
        nxt = words[i + 1]["start"] if i + 1 < len(words) else w["last"] + 0.3
        end = min(nxt, w["last"] + 0.45)
        out.append({"text": w["text"].lower(), "start": w["start"], "end": max(end, w["start"] + 0.08)})
    return out

for line in sys.stdin:
    try:
        req = json.loads(line)
        tokens, stamps = decode(req["assetPath"])
        words = to_words(tokens, stamps)
        groups, cur = [], []
        for w in words:
            if cur and w["start"] - cur[-1]["end"] >= PAUSE_SPLIT_S:
                groups.append(cur); cur = []
            cur.append(w)
        if cur: groups.append(cur)
        segments = []
        for i, g in enumerate(groups):
            text = " ".join(w["text"] for w in g)
            text = text[0].upper() + text[1:] + "."
            g[-1]["text"] += "."
            segments.append({"id": f"{req.get('assetId', 'asset')}-segment-{i}", "startUs": round(g[0]["start"] * 1e6), "endUs": round(g[-1]["end"] * 1e6), "text": text,
                "words": [{"text": w["text"], "startUs": round(w["start"] * 1e6), "endUs": round(w["end"] * 1e6)} for w in g], "providerVersion": "sherpa-onnx-test-shim"})
        sys.stdout.write(json.dumps({"segments": segments}) + "\n"); sys.stdout.flush()
    except Exception as exc:
        sys.stdout.write(json.dumps({"error": str(exc)}) + "\n"); sys.exit(1)
