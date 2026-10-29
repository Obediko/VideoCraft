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
