import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../dist/server.js";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { InMemoryAssetRepository, InMemoryProjectRepository, InMemoryRevisionRepository } from "@videocraft/application";

function dependencies(authenticate) {
  const proposalValues = new Map();
  return {
    projects: new InMemoryProjectRepository(),
    assets: new InMemoryAssetRepository(),
    revisions: new InMemoryRevisionRepository(),
    authenticate,
    authorize: { canAccess: async () => true },
    strategies: new StaticStrategyRegistry(),
    transcripts: { listForAsset: async () => [], replaceForAsset: async () => {} },
    proposals: {
      async save(proposal) { proposalValues.set(proposal.id, proposal); },
      async get(id) { return proposalValues.get(id); },
      async setStatus(id, status) { proposalValues.set(id, { ...proposalValues.get(id), status }); }
    },
    clock: { now: () => "2026-10-21T00:00:00.000Z" },
    ids: { next: (() => { let n = 0; return () => "id-" + (++n); })() }
  };
}

test("health endpoint is public", async () => {
  const server = buildServer(dependencies(async () => null));
  const response = await server.inject({ method: "GET", url: "/healthz" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await server.close();
});

test("project creation requires authentication", async () => {
  const server = buildServer(dependencies(async () => null));
  const response = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Demo" } });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthorized");
  await server.close();
});

test("authenticated users can create projects", async () => {
  const server = buildServer(dependencies(async () => ({ userId: "user-1" })));
  const response = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: " Demo " } });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().project.name, "Demo");
  assert.equal(response.json().project.ownerId, "user-1");
  await server.close();
});

test("proposal preview persists and can be rejected", async () => {
  const server = buildServer(dependencies(async () => ({ userId: "user-1" })));
  const created = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Demo" } });
  const projectId = created.json().project.id;
  const saved = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions", payload: { timeline: { durationUs: 100, tracks: [] } } });
  assert.equal(saved.statusCode, 201);
  const preview = await server.inject({
    method: "POST", url: "/v1/projects/" + projectId + "/proposals",
    payload: { revision: 1, strategyId: "short-form-explainer", profile: { intent: "Explain the product", audience: "Founders", channel: "short-form", constraints: [] } }
  });
  assert.equal(preview.statusCode, 200);
  const proposal = preview.json().proposal;
  assert.equal(proposal.status, "proposed");
  const decision = await server.inject({
    method: "POST", url: "/" + "v1/projects/" + projectId + "/proposals/" + proposal.id + "/decision",
    payload: { decision: "rejected" }
  });
  assert.equal(decision.statusCode, 200);
  assert.equal(decision.json().proposal.status, "rejected");
  await server.close();
});
