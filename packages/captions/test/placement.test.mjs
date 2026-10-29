import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPTION_STYLES, captionMarginFor, faceDuring, faceInOutput, renderAss, renderGraphicsAss } from "../dist/index.js";

const tall = { width: 1080, height: 1920 };
const pop = CAPTION_STYLES["bold-pop"];

test("faceDuring unions the sampled boxes in a range and ignores gaps", () => {
  const track = { step: 0.5, boxes: [null, [0.4, 0.3, 0.6, 0.5], [0.42, 0.32, 0.62, 0.52], null, null, null] };
  assert.deepEqual(faceDuring(track, 0, 1_000_000), [0.4, 0.3, 0.62, 0.52]);
  assert.equal(faceDuring(track, 2_000_000, 2_400_000), undefined);
  assert.equal(faceDuring(undefined, 0, 1), undefined);
});

test("faceInOutput follows the cover crop of a wide source into a tall frame", () => {
  // 1920x1080 into 1080x1920: scale 1920/1080, picture 3413 wide, centred crop.
  const box = faceInOutput([0.45, 0.4, 0.55, 0.6], { source: { width: 1920, height: 1080 }, output: tall, fit: "cover", focus: null });
  const s = 1920 / 1080; const iw = 1920 * s; const ox = (iw - 1080) / 2;
  assert.ok(Math.abs(box.x0 - (0.45 * iw - ox)) < 1 && Math.abs(box.y0 - 0.4 * 1920) < 1);
  // Contain letterboxes: the same face is small and in the middle band.
  const boxed = faceInOutput([0.45, 0.4, 0.55, 0.6], { source: { width: 1920, height: 1080 }, output: tall, fit: "contain" });
  assert.ok(boxed.y0 > 850 && boxed.y1 < 1100, JSON.stringify(boxed));
  // A punch zoom makes the face bigger.
  const zoomed = faceInOutput([0.45, 0.4, 0.55, 0.6], { source: { width: 1920, height: 1080 }, output: tall, fit: "cover", focus: null, zoom: "punch" });
  assert.ok(zoomed.y1 - zoomed.y0 > box.y1 - box.y0);
});

test("captions keep their usual place when the face is clear of it", () => {
  assert.equal(captionMarginFor({ x0: 300, y0: 300, x1: 800, y1: 900 }, pop, tall), Math.round(1920 * 0.3));
  assert.equal(captionMarginFor(undefined, pop, tall), Math.round(1920 * 0.3));
});

test("captions move below a low face when there is room, else above it", () => {
  // Face 900..1300: the usual band (about 1144..1344) overlaps; below it (from ~1338) fits.
  const below = captionMarginFor({ x0: 300, y0: 900, x1: 800, y1: 1300 }, pop, tall);
  assert.ok(1920 - below - 250 >= 1300, "caption top is below the face: " + below);
  assert.ok(below >= 1920 * 0.1);
  // Face filling the bottom: captions go above it.
  const above = captionMarginFor({ x0: 200, y0: 1000, x1: 900, y1: 1800 }, pop, tall);
  assert.ok(1920 - above <= 1000, "caption bottom is above the face: " + above);
});

test("a caption's margin is written into its ASS events", () => {
  const ass = renderAss([{ startUs: 0, endUs: 1_000_000, text: "hello there", wordDurationsCs: [50, 50], marginV: 321 }, { startUs: 1_000_000, endUs: 2_000_000, text: "plain" }], pop, tall);
  const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.ok(events.slice(0, 2).every((e) => e.includes(",Default,,0,0,321,,")));
  assert.ok(events[2].includes(",Default,,0,0,0,,"));
});

test("titles and lower thirds move off the face", () => {
  const face = { x0: 200, y0: 600, x1: 900, y1: 1100 };
  const ass = renderGraphicsAss([{ kind: "title", text: "Big idea", startUs: 0, endUs: 2_000_000, face }], undefined, tall);
  const y = Number(/\\pos\(\d+,(\d+)\)/.exec(ass)[1]);
  assert.ok(y < 600 || y > 1100, "title at " + y);
  const lower = renderGraphicsAss([{ kind: "lower-third", text: "Obed", subtitle: "Founder", startUs: 0, endUs: 2_000_000, face: { x0: 0, y0: 1050, x1: 700, y1: 1400 } }], undefined, tall);
  const top = Number(/\\move\(-?\d+,(\d+),/.exec(lower)[1]);
  assert.ok(top > 1400 || top < 1050, "lower third at " + top);
});
