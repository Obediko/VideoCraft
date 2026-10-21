import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FasterWhisperWorker, safeMediaPath } from "../dist/index.js";

test("media path resolver prevents traversal", () => {
  assert.equal(safeMediaPath("/media", "project/video.mp4"), "/media/project/video.mp4");
  assert.throws(() => safeMediaPath("/media", "../secret.mp4"), /escapes/);
  assert.throws(() => safeMediaPath("/media", "C:\\secret.mp4"), /Invalid/);
});


test("transcription stages inputs through a storage adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "videocraft-transcription-"));
  const workerPath = join(directory, "worker.py");
  await writeFile(workerPath, [
    "import json, os, sys",
    "request = json.loads(sys.stdin.readline())",
    "assert os.path.exists(request['assetPath'])",
    "print(json.dumps({'segments': [{'startUs': 0, 'endUs': 1000, 'text': 'hello'}]}))",
  ].join("\n"));
  try {
    const transcriber = new FasterWhisperWorker({
      workerPath,
      pythonCommand: "python",
      storage: { downloadToFile: async (_key, destination) => writeFile(destination, "media") },
    });
    const segments = await transcriber.transcribe({
      id: "asset-1",
      projectId: "project-1",
      kind: "video",
      storageKey: "projects/project-1/assets/source.mp4",
      checksumSha256: "a".repeat(64),
      metadata: {},
      createdAt: "2026-10-21T00:00:00.000Z",
    });
    assert.equal(segments[0].text, "hello");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
