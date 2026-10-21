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
