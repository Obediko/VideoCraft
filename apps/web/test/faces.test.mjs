import test from "node:test";
import assert from "node:assert/strict";
import { CAPTION_STYLES, captionMarginFor, faceInOutput } from "@videocraft/captions";
import { captionBottomFor, faceInFrame, focusDuring, titleTopFor } from "../test-dist/preview.js";

const tall = { width: 1080, height: 1920 };
const wideSource = { width: 1920, height: 1080 };

test("the preview maps faces into the frame the same way as the export", () => {
  for (const [fit, focus, zoom] of [["cover", null, 1], ["cover", { x: 0.3, y: 0.5 }, 1], ["contain", null, 1], ["cover", null, 1.12]]) {
    const box = [0.4, 0.3, 0.6, 0.6];
    const exp = faceInOutput(box, { source: wideSource, output: tall, fit, focus, ...(zoom > 1 ? { zoom: "punch" } : {}) });
    const pre = faceInFrame(box, wideSource, tall, fit, focus, zoom);
    for (const [k, scale] of [["x0", 1080], ["y0", 1920], ["x1", 1080], ["y1", 1920]]) assert.ok(Math.abs(exp[k] / scale - pre[k]) < 0.002, fit + " " + k);
  }
});

test("the preview places captions where the export does", () => {
  for (const face of [undefined, { x0: 300, y0: 300, x1: 800, y1: 900 }, { x0: 300, y0: 900, x1: 800, y1: 1300 }, { x0: 200, y0: 1000, x1: 900, y1: 1800 }]) {
    const exp = captionMarginFor(face, CAPTION_STYLES["bold-pop"], tall) / 1920;
    const pre = captionBottomFor(face && { x0: face.x0 / 1080, y0: face.y0 / 1920, x1: face.x1 / 1080, y1: face.y1 / 1920 }, "bold-pop");
    assert.ok(Math.abs(exp - pre) < 0.003, JSON.stringify(face) + " " + exp + " vs " + pre);
  }
});

test("crop focus follows the face and titles move off it", () => {
  const track = { step: 0.5, boxes: [[0.1, 0.2, 0.3, 0.5], [0.12, 0.2, 0.32, 0.5], null, [0.1, 0.2, 0.3, 0.5]] };
  const f = focusDuring(track, 0, 2_000_000);
  assert.ok(f && Math.abs(f.x - 0.2) < 0.02);
  assert.equal(focusDuring({ step: 0.5, boxes: [null, null, null, null] }, 0, 2_000_000), null);
  const top = titleTopFor("center", { x0: 0.2, y0: 0.3, x1: 0.8, y1: 0.6 }, 0.6);
  assert.ok(top + 0.12 <= 0.3 || top >= 0.6, "title at " + top);
});
