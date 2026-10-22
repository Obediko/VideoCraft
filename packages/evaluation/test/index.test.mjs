import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStrategyFeedback } from "../dist/index.js";

test("evaluation reports decision and downstream outcome rates for one strategy", () => {
  const events = [
    { id: "a", projectId: "p", revision: 1, strategyId: "short-form-explainer", type: "accepted", createdAt: "2026-01-01T00:00:00Z" },
    { id: "b", projectId: "p", revision: 2, strategyId: "short-form-explainer", type: "edited", createdAt: "2026-01-01T00:00:01Z" },
    { id: "c", projectId: "p", revision: 3, strategyId: "short-form-explainer", type: "exported", createdAt: "2026-01-01T00:00:02Z" },
    { id: "d", projectId: "p", revision: 3, strategyId: "other-strategy", type: "rejected", createdAt: "2026-01-01T00:00:03Z" }
  ];
  const report = evaluateStrategyFeedback(events, "short-form-explainer");
  assert.equal(report.totalEvents, 3);
  assert.equal(report.decisionEvents, 2);
  assert.equal(report.accepted, 1);
  assert.equal(report.edited, 1);
  assert.equal(report.exported, 1);
  assert.equal(report.acceptanceRate, 0.5);
  assert.equal(report.editRate, 0.5);
  assert.equal(report.outcomeScore, 0.5);
});

test("evaluation is explicit and empty strategies do not fabricate signal", () => {
  const report = evaluateStrategyFeedback([], "short-form-explainer");
  assert.deepEqual(report, {
    strategyId: "short-form-explainer",
    totalEvents: 0,
    decisionEvents: 0,
    accepted: 0,
    rejected: 0,
    edited: 0,
    exported: 0,
    shared: 0,
    acceptanceRate: 0,
    editRate: 0,
    outcomeScore: 0
  });
});
