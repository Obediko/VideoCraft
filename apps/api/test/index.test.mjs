import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../dist/server.js";
import {
  InMemoryAssetRepository,
  InMemoryProjectRepository,
  InMemoryRevisionRepository
} from "@videocraft/application";

function dependencies(authenticate) {
  return {
    projects: new InMemoryProjectRepository(),
    assets: new InMemoryAssetRepository(),
    revisions: new InMemoryRevisionRepository(),
    authenticate,
    authorize: { canAccess: async () => true },
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
  const response = await server.inject({
    method: "POST",
    url: "/v1/projects",
    payload: { name: "Demo" }
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthorized");
  await server.close();
});

test("authenticated users can create projects", async () => {
  const server = buildServer(dependencies(async () => ({ userId: "user-1" })));
  const response = await server.inject({
    method: "POST",
    url: "/v1/projects",
    payload: { name: " Demo " }
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().project.name, "Demo");
  assert.equal(response.json().project.ownerId, "user-1");
  await server.close();
});
