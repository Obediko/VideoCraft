"""JSON-lines PySceneDetect worker."""
from __future__ import annotations

import json
import sys

from scenedetect import ContentDetector, detect


for line in sys.stdin:
    try:
        request = json.loads(line)
        input_path = request.get("inputPath")
        if not isinstance(input_path, str) or not input_path:
            raise ValueError("inputPath is required")
        scenes = detect(input_path, ContentDetector())
        result = []
        for index, (start, end) in enumerate(scenes):
            result.append({
                "id": f"scene-{index}",
                "startUs": round(start.get_seconds() * 1_000_000),
                "endUs": round(end.get_seconds() * 1_000_000),
            })
        sys.stdout.write(json.dumps({"scenes": result}, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except Exception as exc:
        sys.stderr.write(str(exc) + "\n")
        sys.stderr.flush()
        raise
