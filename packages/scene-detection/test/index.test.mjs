import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PySceneDetectWorker } from "../dist/index.js";

test("scene detection stages provider-backed inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "videocraft-scenes-"));
  const workerPath = join(directory, "worker.py");
  await writeFile(workerPath, [
    "import json, os, sys",
    "request = json.loads(sys.stdin.readline())",
    "assert os.path.exists(request['inputPath'])",
    "print(json.dumps({'scenes': [{'id': 'scene-1', 'startUs': 0, 'endUs': 1000}]}))",
  ].join("\n"));
  try {
    const detector = new PySceneDetectWorker({
      workerPath,
      pythonCommand: "python",
      storage: { downloadToFile: async (_key, destination) => writeFile(destination, "media") }
    });
    const scenes = await detector.detect("projects/project-1/assets/source.mp4");
    assert.deepEqual(scenes, [{ id: "scene-1", startUs: 0, endUs: 1000 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("scene detection removes staged inputs when the worker returns invalid output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "videocraft-scenes-invalid-"));
  const workerPath = join(directory, "worker.py");
  await writeFile(workerPath, "print('not-json')");
  let stagedPath;
  try {
    const detector = new PySceneDetectWorker({
      workerPath,
      pythonCommand: "python",
      storage: { downloadToFile: async (_key, destination) => { stagedPath = destination; await writeFile(destination, "media"); } }
    });
    await assert.rejects(() => detector.detect("projects/project-1/assets/source.mp4"), /invalid JSON/);
    await assert.rejects(() => access(stagedPath), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
