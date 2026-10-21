"""Smoke-test the OTIO JSON-lines worker against the installed provider package."""
from __future__ import annotations

import json
import subprocess
import sys

request = {"document": {"OTIO_SCHEMA": "Timeline.1", "name": "VideoCraft CI"}}
completed = subprocess.run(
    [sys.executable, "workers/timeline/otio_worker.py"],
    input=json.dumps(request) + "\n",
    text=True,
    capture_output=True,
    check=True,
)
result = json.loads(completed.stdout)
assert result["ok"] is True, result
assert result["document"]["OTIO_SCHEMA"] == "Timeline.1"
