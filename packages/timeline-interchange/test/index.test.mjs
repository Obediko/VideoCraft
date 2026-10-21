import test from "node:test";
import assert from "node:assert/strict";
import { exportOtio, importOtio } from "../dist/index.js";

test("OTIO-shaped interchange round-trips the internal timeline", () => {
  const timeline = { durationUs: 5_000_000, tracks: [{ id: "video", kind: "video", clips: [{ id: "clip", assetId: "asset", sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 1_000_000, timelineEndUs: 3_000_000 }] }] };
  assert.deepEqual(importOtio(exportOtio(timeline)), timeline);
});
