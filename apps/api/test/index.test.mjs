import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../dist/server.js";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { InMemoryAssetRepository, InMemoryProjectMemberRepository, InMemoryProjectRepository, InMemoryRevisionRepository } from "@videocraft/application";
import { MetricsRegistry } from "@videocraft/observability";

function dependencies(authenticate, overrides = {}) {
  const proposalValues = new Map();
  return {
    projects: new InMemoryProjectRepository(),
    assets: new InMemoryAssetRepository(),
    revisions: new InMemoryRevisionRepository(),
    members: new InMemoryProjectMemberRepository(),
    authenticate: { authenticate },
    authorize: { canAccess: async () => true },
    strategies: new StaticStrategyRegistry(),
    transcripts: { listForAsset: async () => [], replaceForAsset: async () => {} },
    proposals: {
      async save(proposal) { proposalValues.set(proposal.id, proposal); },
      async get(id) { return proposalValues.get(id); },
      async setStatus(id, status) { proposalValues.set(id, { ...proposalValues.get(id), status }); }
    },
    clock: { now: () => "2026-10-21T00:00:00.000Z" },
    ids: { next: (() => { let n = 0; return () => "id-" + (++n); })() },
    ...overrides
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


test("readiness reports dependency failures without affecting liveness", async () => {
  const server = buildServer(dependencies(async () => null, {
    readiness: [{ name: "database", check: async () => false }]
  }));
  const live = await server.inject({ method: "GET", url: "/healthz" });
  const ready = await server.inject({ method: "GET", url: "/readyz" });
  assert.equal(live.statusCode, 200);
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json(), { status: "not_ready", dependency: "database" });
  await server.close();
});

test("metrics endpoint exposes bounded request counters", async () => {
  const metrics = new MetricsRegistry();
  const server = buildServer(dependencies(async () => null, { metrics }));
  await server.inject({ method: "GET", url: "/healthz" });
  const response = await server.inject({ method: "GET", url: "/metrics" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/plain/);
  assert.match(response.body, /videocraft_http_requests_total/);
  assert.match(response.body, /route="\/healthz"/);
  await server.close();
});


test("project-scoped mutations deny principals without project access", async () => {
  const server = buildServer(dependencies(async () => ({ userId: "user-1" }), {
    authorize: { canAccess: async () => false }
  }));
  const created = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Private" } });
  const projectId = created.json().project.id;
  const response = await server.inject({
    method: "POST",
    url: "/v1/projects/" + projectId + "/revisions",
    payload: { timeline: { durationUs: 100, tracks: [] } }
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "forbidden");
  await server.close();
});


test("authenticated users can list and retrieve their projects", async () => {
  const server = buildServer(dependencies(async () => ({ userId: "user-1" })));
  const first = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "First" } });
  const second = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Second" } });
  const list = await server.inject({ method: "GET", url: "/v1/projects" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().projects.map((project) => project.name), ["First", "Second"]);
  const projectId = second.json().project.id;
  const retrieved = await server.inject({ method: "GET", url: "/v1/projects/" + projectId });
  assert.equal(retrieved.statusCode, 200);
  assert.equal(retrieved.json().project.id, projectId);
  await server.close();
});


test("authorized users can retrieve a saved revision", async () => {
  const server = buildServer(dependencies(async () => ({ userId: "user-1" })));
  const created = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Revision project" } });
  const projectId = created.json().project.id;
  const saved = await server.inject({
    method: "POST",
    url: "/v1/projects/" + projectId + "/revisions",
    payload: { timeline: { durationUs: 100, tracks: [] } }
  });
  assert.equal(saved.statusCode, 201);
  const response = await server.inject({ method: "GET", url: "/v1/projects/" + projectId + "/revisions/1" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().revision.projectId, projectId);
  assert.equal(response.json().revision.revision, 1);
  await server.close();
});


test("authorized users can list project assets", async () => {
  const deps = dependencies(async () => ({ userId: "user-1" }));
  const server = buildServer(deps);
  const created = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Assets" } });
  const projectId = created.json().project.id;
  await deps.assets.save({
    id: "asset-1",
    projectId,
    kind: "video",
    storageKey: "projects/" + projectId + "/assets/asset-1.media",
    checksumSha256: "a".repeat(64),
    metadata: { filename: "demo.mp4" },
    createdAt: "2026-10-21T00:00:00.000Z"
  });
  const response = await server.inject({ method: "GET", url: "/v1/projects/" + projectId + "/assets" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().assets[0].id, "asset-1");
  await server.close();
});


test("project owners can manage members and members can be listed", async () => {
  const deps = dependencies(async () => ({ userId: "owner-1" }));
  const server = buildServer(deps);
  const created = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Shared" } });
  const projectId = created.json().project.id;
  const added = await server.inject({
    method: "PUT",
    url: "/v1/projects/" + projectId + "/members/user-2",
    payload: { role: "editor" }
  });
  assert.equal(added.statusCode, 200);
  assert.equal(added.json().member.userId, "user-2");
  const listed = await server.inject({ method: "GET", url: "/v1/projects/" + projectId + "/members" });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().members.map((member) => member.userId), ["user-2"]);
  const removed = await server.inject({ method: "DELETE", url: "/v1/projects/" + projectId + "/members/user-2" });
  assert.equal(removed.statusCode, 204);
  await server.close();
});

test("non-owners cannot manage project members", async () => {
  let principalId = "owner-1";
  const deps = dependencies(async () => ({ userId: principalId }));
  const server = buildServer(deps);
  const created = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Private" } });
  principalId = "not-owner";
  const projectId = created.json().project.id;
  const response = await server.inject({
    method: "PUT",
    url: "/v1/projects/" + projectId + "/members/user-2",
    payload: { role: "viewer" }
  });
  assert.equal(response.statusCode, 403);
  await server.close();
});


test("authorized editors can request project-scoped scene detection", async () => {
  const deps = dependencies(async () => ({ userId: "user-1" }), {
    sceneDetector: { detect: async (storageKey) => {
      assert.equal(storageKey, "projects/project-1/assets/asset-1.media");
      return [{ id: "scene-1", startUs: 0, endUs: 1_000_000 }];
    } }
  });
  const server = buildServer(deps);
  const created = await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Scenes" } });
  const projectId = created.json().project.id;
  await deps.assets.save({
    id: "asset-1",
    projectId,
    kind: "video",
    storageKey: "projects/project-1/assets/asset-1.media",
    checksumSha256: "b".repeat(64),
    metadata: {},
    createdAt: "2026-10-21T00:00:00.000Z"
  });
  const response = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/assets/asset-1/scenes" });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().scenes, [{ id: "scene-1", startUs: 0, endUs: 1_000_000 }]);
  await server.close();
});
