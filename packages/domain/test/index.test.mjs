import test from "node:test";
import assert from "node:assert/strict";
import { validateProposal, validateTimeline } from "../dist/index.js";

test("rejects a timeline clip outside the timeline", () => {
  assert.throws(() => validateTimeline({
    durationUs: 100,
    tracks: [{
      id: "track-1",
      kind: "video",
      clips: [{
        id: "clip-1",
        assetId: "asset-1",
        sourceStartUs: 0,
        sourceEndUs: 50,
        timelineStartUs: 80,
        timelineEndUs: 120
      }]
    }]
  }), /exceeds/);
});

test("requires evidence for proposals", () => {
  assert.throws(() => validateProposal({
    id: "proposal-1",
    projectId: "project-1",
    baseRevision: 1,
    strategyId: "strategy",
    strategyVersion: "1.0.0",
    rationale: "test",
    confidence: 0.5,
    evidence: [],
    operations: [],
    status: "proposed"
  }), /evidence/);
});

import { applyTimelineOperations } from "../dist/index.js";

const baseTimeline = () => ({ durationUs: 10_000_000, tracks: [{ id: "v", kind: "video", clips: [{ id: "c1", assetId: "a", sourceStartUs: 0, sourceEndUs: 10_000_000, timelineStartUs: 0, timelineEndUs: 10_000_000 }] }] });

test("insert, reorder and remove ripple the video track and shrink the duration", () => {
  const edited = applyTimelineOperations(baseTimeline(), [
    { type: "remove-clip", clipId: "c1", reason: "replace with highlights" },
    { type: "insert-clip", assetId: "a", sourceStartUs: 6_000_000, sourceEndUs: 8_000_000, reason: "second" },
    { type: "insert-clip", assetId: "a", sourceStartUs: 1_000_000, sourceEndUs: 4_000_000, reason: "first" },
  ]);
  const clips = edited.tracks[0].clips;
  assert.deepEqual(clips.map((c) => [c.timelineStartUs, c.timelineEndUs]), [[0, 2_000_000], [2_000_000, 5_000_000]]);
  assert.equal(edited.durationUs, 5_000_000);
  const reordered = applyTimelineOperations(edited, [{ type: "reorder-clips", clipIds: clips.map((c) => c.id).reverse() }]);
  assert.deepEqual(reordered.tracks[0].clips.map((c) => c.sourceStartUs), [1_000_000, 6_000_000]);
  assert.throws(() => applyTimelineOperations(edited, [{ type: "reorder-clips", clipIds: [clips[0].id] }]), /every video clip/);
});

test("source-bound caption cues follow clips and disappear with removed audio", () => {
  let timeline = applyTimelineOperations(baseTimeline(), [
    { type: "remove-clip", clipId: "c1", reason: "x" },
    { type: "insert-clip", assetId: "a", sourceStartUs: 5_000_000, sourceEndUs: 7_000_000, reason: "keep" },
    { type: "add-caption-cue", assetId: "a", sourceStartUs: 5_500_000, sourceEndUs: 6_500_000, text: "hello there", wordDurationsCs: [50, 50] },
    { type: "add-caption-cue", assetId: "a", sourceStartUs: 1_000_000, sourceEndUs: 2_000_000, text: "dropped" },
  ]);
  const cues = timeline.tracks.find((t) => t.kind === "caption").clips;
  assert.equal(cues.length, 1);
  assert.deepEqual([cues[0].timelineStartUs, cues[0].timelineEndUs], [500_000, 1_500_000]);
  timeline = applyTimelineOperations(timeline, [{ type: "update-caption", clipId: cues[0].id, text: "hello world" }]);
  const corrected = timeline.tracks.find((t) => t.kind === "caption").clips[0];
  assert.equal(corrected.transform.text, "hello world");
  assert.equal(corrected.transform.wordDurationsCs, "50,50");
  timeline = applyTimelineOperations(timeline, [{ type: "update-caption", clipId: cues[0].id, text: "hello big wide world" }]);
  const respelled = timeline.tracks.find((t) => t.kind === "caption").clips[0].transform.wordDurationsCs.split(",").map(Number);
  assert.equal(respelled.length, 4);
  assert.equal(respelled.reduce((a, b) => a + b, 0), 100);
});

test("trim and split keep working and ripple", () => {
  const trimmed = applyTimelineOperations(baseTimeline(), [{ type: "trim-clip", clipId: "c1", sourceStartUs: 1_000_000, sourceEndUs: 4_000_000 }]);
  assert.equal(trimmed.durationUs, 3_000_000);
  const split = applyTimelineOperations(trimmed, [{ type: "split-clip", clipId: "c1", atUs: 2_000_000 }]);
  assert.deepEqual(split.tracks[0].clips.map((c) => c.id), ["c1:a", "c1:b"]);
  assert.throws(() => applyTimelineOperations(split, [{ type: "remove-clip", clipId: "nope", reason: "x" }]), /unknown clip/);
});

import { parseTimelineOperations } from "../dist/index.js";
test("operation parser accepts valid operations and rejects malformed ones", () => {
  const ops = parseTimelineOperations([{ type: "insert-clip", assetId: "a", sourceStartUs: 0, sourceEndUs: 5, reason: "r", extra: "ignored" }, { type: "update-caption", clipId: "x", text: "hi" }]);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].extra, undefined);
  assert.throws(() => parseTimelineOperations([]), /non-empty/);
  assert.throws(() => parseTimelineOperations([{ type: "trim-clip", clipId: "c", sourceStartUs: 5, sourceEndUs: 1 }]), /operations\[0\]/);
  assert.throws(() => parseTimelineOperations([{ type: "format-disk" }]), /unknown operation/);
  assert.throws(() => parseTimelineOperations([{ type: "update-caption", clipId: "x", text: "   " }]), /non-empty text/);
});
