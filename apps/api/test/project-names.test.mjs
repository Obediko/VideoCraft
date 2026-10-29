import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../dist/server.js";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { InMemoryAssetRepository, InMemoryProjectMemberRepository, InMemoryProjectRepository, InMemoryRevisionRepository, InMemorySceneRepository } from "@videocraft/application";

test("project names are unique per person: create and rename refuse a name already in use", async () => {
  const projects = new InMemoryProjectRepository();
  let user = "obed";
  let n = 0;
  const server = buildServer({
    projects, assets: new InMemoryAssetRepository(), revisions: new InMemoryRevisionRepository(), members: new InMemoryProjectMemberRepository(), scenes: new InMemorySceneRepository(),
    authenticate: { authenticate: async () => ({ userId: user }) }, authorize: { canAccess: async () => true }, strategies: new StaticStrategyRegistry(),
    clock: { now: () => new Date().toISOString() }, ids: { next: () => "id-" + ++n },
  });
  const create = (name) => server.inject({ method: "POST", url: "/v1/projects", payload: { name } });
  const first = await create("Launch reel");
  assert.equal(first.statusCode, 201);
  const clash = await create("  launch   REEL ");
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.json().error.code, "project_name_taken");
  assert.match(clash.json().error.message, /already have a project called "Launch reel"/);
  assert.equal((await create("Launch reel 2")).statusCode, 201);
  assert.equal((await create("Tidy   spaces ")).json().project.name, "Tidy spaces", "names are stored trimmed with single spaces");

  const second = (await server.inject({ url: "/v1/projects" })).json().projects.find((p) => p.name === "Launch reel 2");
  const rename = (id, name) => server.inject({ method: "PATCH", url: "/v1/projects/" + id, payload: { name } });
  assert.equal((await rename(second.id, "LAUNCH REEL")).statusCode, 409, "renaming onto another project's name is refused");
  assert.equal((await rename(first.json().project.id, "launch reel")).statusCode, 200, "changing the case of your own name is fine");

  user = "someone-else";
  assert.equal((await create("Launch reel")).statusCode, 201, "another person may use the same name");
});
