import test from "node:test";
import assert from "node:assert/strict";
import { applyTimelineOperations } from "@videocraft/domain";
import { keptWords, rangeForWords, removeRangeOps, restoreRangeOps, cueOps, timelineToSource, sourceToTimeline, secondsFromBrief } from "../test-dist/story.js";

const A = "talk";
const words = Array.from({ length: 20 }, (_, i) => ({ text: "w" + i + (i % 5 === 4 ? "." : ""), startUs: 1_000_000 + i * 500_000, endUs: 1_000_000 + i * 500_000 + 380_000 }));
const base = (clips) => applyTimelineOperations({ durationUs: 0, tracks: [] }, [...clips.map(([s, e]) => ({ type: "insert-clip", assetId: A, sourceStartUs: s, sourceEndUs: e, reason: "r" })), ...cueOps(words, A)]);
const video = (t) => t.tracks.find((x) => x.kind === "video").clips;
const cues = (t) => t.tracks.find((x) => x.kind === "caption")?.clips ?? [];
const kept = (t) => keptWords(words, video(t), A).map((k) => (k ? 1 : 0)).join("");

test("cutting words from the middle of a clip splits it and drops just those words, captions follow", () => {
  let t = base([[800_000, 11_000_000]]);
  assert.equal(kept(t), "11111111111111111111");
  t = applyTimelineOperations(t, removeRangeOps(rangeForWords(words, 6, 8), video(t), cues(t), words, A));
  assert.equal(kept(t), "11111100011111111111");
  assert.equal(video(t).length, 2);
  const shown = cues(t).map((c) => c.transform.text).join(" ");
  assert.ok(!/\bw[678]\b/.test(shown) && /w5/.test(shown) && /w9/.test(shown), "captions keep only words still in the cut: " + shown);
});

test("cutting across clip edges trims both clips; whole clips inside the range go", () => {
  let t = base([[800_000, 3_400_000], [3_400_000, 6_400_000], [6_400_000, 11_000_000]]);
  t = applyTimelineOperations(t, removeRangeOps(rangeForWords(words, 3, 12), video(t), cues(t), words, A));
  assert.equal(kept(t), "11100000000001111111");
});

test("bringing words back inserts them in source order with captions, without duplicating kept parts", () => {
  let t = base([[800_000, 3_400_000], [6_400_000, 11_000_000]]);
  assert.equal(kept(t), "11111000000111111111");
  const before = kept(t);
  t = applyTimelineOperations(t, restoreRangeOps(rangeForWords(words, 3, 10), video(t), words, A));
  assert.equal(kept(t), "11111111111111111111", "was " + before);
  const order = video(t).map((c) => c.sourceStartUs);
  assert.deepEqual([...order].sort((x, y) => x - y), order, "pieces play in source order");
  assert.ok(cues(t).some((c) => /w7/.test(c.transform.text)), "restored words get captions");
});

test("time mapping between the edit and the source", () => {
  const t = base([[6_400_000, 8_000_000], [800_000, 2_000_000]]);
  const clips = video(t);
  assert.deepEqual(timelineToSource(clips, 500_000), { assetId: A, sourceUs: 6_900_000 });
  assert.equal(sourceToTimeline(clips, A, 1_000_000), 1_600_000 + 200_000);
  assert.equal(sourceToTimeline(clips, A, 4_000_000), undefined);
});

test("length from the description", () => {
  assert.equal(secondsFromBrief("A 30 second Reel"), 30);
  assert.equal(secondsFromBrief("a 2 minute YouTube video"), 120);
  assert.equal(secondsFromBrief("about our programme"), undefined);
});

test("cutting and then bringing words back heals the clip instead of leaving fragments", () => {
  let t = base([[800_000, 11_000_000]]);
  const range = rangeForWords(words, 6, 8);
  t = applyTimelineOperations(t, removeRangeOps(range, video(t), cues(t), words, A));
  assert.equal(video(t).length, 2);
  t = applyTimelineOperations(t, restoreRangeOps(range, video(t), words, A));
  assert.equal(kept(t), "11111111111111111111");
  assert.equal(video(t).length, 1, "one clip again: " + JSON.stringify(video(t).map((c) => [c.sourceStartUs, c.sourceEndUs])));
});

test("live preview: transition veils and zooms match the export's rules", async () => {
  const { veilAt, zoomAt } = await import("../test-dist/preview.js");
  const clips = [
    { id: "a", assetId: A, sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000, transform: { transitionIn: "dip-black" } },
    { id: "b", assetId: A, sourceStartUs: 5_000_000, sourceEndUs: 7_000_000, timelineStartUs: 2_000_000, timelineEndUs: 4_000_000, transform: { transitionIn: "flash", zoom: "push" } },
    { id: "c", assetId: A, sourceStartUs: 9_000_000, sourceEndUs: 11_000_000, timelineStartUs: 4_000_000, timelineEndUs: 6_000_000, transform: { transitionIn: "dip-white", transitionOut: "dip-black", zoom: "punch" } },
  ];
  assert.equal(veilAt(clips, 0, 6_000_000).opacity, 1, "fades in from black");
  assert.equal(veilAt(clips, 1_000_000, 6_000_000).opacity, 0, "clear mid-clip");
  assert.deepEqual(veilAt(clips, 2_000_000, 6_000_000), { opacity: 1, color: "#fff" }, "flash at the cut");
  assert.equal(veilAt(clips, 2_150_000, 6_000_000).opacity, 0, "flash is short");
  assert.ok(veilAt(clips, 3_900_000, 6_000_000).opacity > 0.5 && veilAt(clips, 3_900_000, 6_000_000).color === "#fff", "dip to white before the third clip");
  assert.ok(veilAt(clips, 5_950_000, 6_000_000).opacity > 0.7 && veilAt(clips, 5_950_000, 6_000_000).color === "#000", "fades out at the end");
  assert.equal(zoomAt(clips[2], 5_000_000), 1.12);
  assert.ok(Math.abs(zoomAt(clips[1], 3_000_000) - 1.04) < 1e-6, "push-in is halfway at mid-clip");
  assert.equal(zoomAt(clips[0], 1_000_000), 1);
});
