"""JSON-lines faster-whisper worker.

The parent process supplies paths already constrained to the configured media root.
This worker never accepts a shell command or an arbitrary output path.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)


def emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def valid_path(value: object) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError("assetPath is required")
    path = Path(value).resolve()
    if not path.is_file():
        raise ValueError("assetPath is not a file")
    return path


for line in sys.stdin:
    try:
        request = json.loads(line)
        path = valid_path(request.get("assetPath"))
        language = request.get("language")
        segments, _ = model.transcribe(
            str(path),
            language=language if isinstance(language, str) and language else None,
            word_timestamps=True,
            vad_filter=True,
        )
        result = []
        for index, segment in enumerate(segments):
            words = []
            for word in segment.words or []:
                words.append({
                    "text": word.word,
                    "startUs": round(word.start * 1_000_000),
                    "endUs": round(word.end * 1_000_000),
                })
            result.append({
                "id": str(request.get("assetId", "asset")) + "-segment-" + str(index),
                "startUs": round(segment.start * 1_000_000),
                "endUs": round(segment.end * 1_000_000),
                "text": segment.text,
                "words": words,
                "providerVersion": "faster-whisper",
            })
        emit({"segments": result})
    except Exception as exc:
        emit({"error": str(exc)})
        sys.exit(1)
