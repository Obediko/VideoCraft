import test from "node:test";
import assert from "node:assert/strict";
import { ShortFormExplainerStrategy, StaticStrategyRegistry } from "../dist/index.js";

test("registers a versioned strategy", () => {
  const registry = new StaticStrategyRegistry();
  assert.deepEqual(registry.list(), [{ id: "short-form-explainer", version: "1.0.0" }]);
  assert.equal(registry.get("short-form-explainer").version, "1.0.0");
});

test("returns an explainable proposal without mutating the revision", async () => {
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
  assert.equal(result.evidence[0].reference, "tailoring-profile.intent");
});
