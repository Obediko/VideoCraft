import test from "node:test";
import assert from "node:assert/strict";
import { exportOtio, importOtio } from "../dist/index.js";

test("OTIO-shaped interchange round-trips the internal timeline", () => {
  const timeline = { durationUs: 5_000_000, tracks: [{ id: "video", kind: "video", clips: [{ id: "clip", assetId: "asset", sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 1_000_000, timelineEndUs: 3_000_000 }] }] };
  assert.deepEqual(importOtio(exportOtio(timeline)), timeline);
});

import { PythonOpenTimelineIOAdapter } from "../dist/index.js";

test("Python OpenTimelineIO adapter validates the provider response and round-trips", async () => {
  const timeline = { durationUs: 5_000_000, tracks: [{ id: "video", kind: "video", clips: [{ id: "clip", assetId: "asset", sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 1_000_000, timelineEndUs: 3_000_000 }] }] };
  const adapter = new PythonOpenTimelineIOAdapter({
    workerPath: "unused",
    runner: async ({ document }) => ({ ok: true, document }),
  });
  assert.deepEqual(await adapter.import(await adapter.export(timeline)), timeline);
});

test("Python OpenTimelineIO adapter fails closed on provider errors", async () => {
  const adapter = new PythonOpenTimelineIOAdapter({
    workerPath: "unused",
    runner: async () => ({ ok: false, error: "OpenTimelineIO is not installed" }),
  });
  await assert.rejects(() => adapter.export({ durationUs: 0, tracks: [] }), /OpenTimelineIO is not installed/);
});
