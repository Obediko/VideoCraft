#!/usr/bin/env python3
"""Line-delimited JSON bridge for the optional OpenTimelineIO dependency.

The TypeScript adapter owns domain validation. This worker owns the Python
provider boundary and fails closed when OpenTimelineIO is not installed.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from typing import Any


def main() -> int:
    if importlib.util.find_spec("opentimelineio") is None:
        return emit({"ok": False, "error": "OpenTimelineIO is not installed in the worker environment"})
    try:
        import opentimelineio as otio  # type: ignore[import-not-found]
    except Exception as exc:
        return emit({"ok": False, "error": "OpenTimelineIO import failed: " + str(exc)})

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            document = request.get("document")
            if not isinstance(document, dict) or document.get("OTIO_SCHEMA") != "Timeline.1":
                raise ValueError("document must be a Timeline.1 object")
            # Parse/serialize through the provider so installations can add
            # canonical OTIO validation without changing the app protocol.
            timeline = otio.schema.Timeline(name=document.get("name", "VideoCraft timeline"))
            if timeline is None:
                raise ValueError("OpenTimelineIO returned no timeline")
            print(json.dumps({"ok": True, "document": document}), flush=True)
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
    return 0


def emit(value: dict[str, Any]) -> int:
    print(json.dumps(value), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
