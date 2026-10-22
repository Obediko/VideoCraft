import test from "node:test";
import assert from "node:assert/strict";
import { ShortFormExplainerStrategy, StaticStrategyRegistry } from "../dist/index.js";

test("registers a versioned strategy", () => {
  const registry = new StaticStrategyRegistry();
  assert.deepEqual(registry.list(), [{ id: "short-form-explainer", version: "1.1.0" }, { id: "highlight-reel", version: "1.0.0" }]);
  assert.equal(registry.get("short-form-explainer").version, "1.1.0");
});

test("returns a safe no-op proposal when no source video exists", async () => {
  const strategy = new ShortFormExplainerStrategy();
  const input = {
    project: { id: "p", ownerId: "o", name: "Demo", revision: 1, createdAt: "", updatedAt: "" },
    revision: { projectId: "p", revision: 1, timeline: { durationUs: 100, tracks: [] }, acceptedProposalIds: [], createdAt: "", createdBy: "o" },
    profile: { intent: "Explain the product", audience: "Founders", channel: "short-form", constraints: [] },
    transcript: []
  };
  const result = await strategy.propose(input);
  assert.equal(result.status, "proposed");
  assert.equal(result.operations.length, 0);
  assert.match(result.rationale, /No source video clip/);
});

test("proposes bounded duration trimming and an audience-aware opening caption", async () => {
  const strategy = new ShortFormExplainerStrategy();
  const result = await strategy.propose({
    project: { id: "p", ownerId: "o", name: "Demo", revision: 1, createdAt: "", updatedAt: "" },
    revision: {
      projectId: "p",
      revision: 1,
      timeline: {
        durationUs: 60_000_000,
        tracks: [{
          id: "video-track",
          kind: "video",
          clips: [{ id: "clip-1", assetId: "asset-1", sourceStartUs: 0, sourceEndUs: 60_000_000, timelineStartUs: 0, timelineEndUs: 60_000_000 }]
        }]
      },
      acceptedProposalIds: [], createdAt: "", createdBy: "o"
    },
    profile: { intent: "Explain the product", audience: "New founders", channel: "short-form", targetDurationUs: 30_000_000, constraints: [] },
    transcript: [{ id: "segment-1", assetId: "asset-1", startUs: 0, endUs: 1_000_000, text: "Welcome", words: [], provider: "test" }]
  });
  assert.equal(result.operations.length, 2);
  assert.deepEqual(result.operations[0], { type: "trim-clip", clipId: "clip-1", sourceStartUs: 0, sourceEndUs: 30_000_000 });
  assert.deepEqual(result.operations[1], { type: "add-caption", text: "For New founders: Explain the product", atUs: 0, durationUs: 3_000_000 });
  assert.equal(result.evidence.filter((entry) => entry.source === "user").length, 4);
  assert.equal(result.confidence, 0.82);
});
