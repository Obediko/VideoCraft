import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { buildServer } from "../dist/server.js";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { LocalObjectStorage } from "@videocraft/storage";
import { InMemoryAssetRepository, InMemoryProjectMemberRepository, InMemoryProjectRepository, InMemoryRevisionRepository, InMemorySceneRepository } from "@videocraft/application";

test("delete project: owner only, name typed back, stored media removed, other projects untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-del-"));
  try {
    const storage = new LocalObjectStorage(dir);
    const projects = new InMemoryProjectRepository(); const assets = new InMemoryAssetRepository(); const members = new InMemoryProjectMemberRepository();
    let user = "owner"; let n = 0;
    const server = buildServer({ projects, assets, revisions: new InMemoryRevisionRepository(), members, scenes: new InMemorySceneRepository(), storage,
      authenticate: { authenticate: async () => ({ userId: user }) },
      authorize: { canAccess: async (p, projectId) => (await projects.get(projectId))?.ownerId === p.userId || p.userId === "editor" },
      strategies: new StaticStrategyRegistry(), clock: { now: () => new Date().toISOString() }, ids: { next: () => "id-" + ++n } });
    const make = async (name) => (await server.inject({ method: "POST", url: "/v1/projects", payload: { name } })).json().project.id;
    const doomed = await make("My first cut"); const kept = await make("Keep me");
    const put = (key) => { const p = storage.resolve(key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "x"); return p; };
    const files = [put("projects/" + doomed + "/assets/a.media"), put("projects/" + doomed + "/renders/r.mp4"), put("projects/" + doomed + "/assets/a.proxy.mp4")];
    const safe = put("projects/" + kept + "/assets/b.media");
    await assets.save({ id: "a", projectId: doomed, kind: "video", storageKey: "projects/" + doomed + "/assets/a.media", checksumSha256: "a".repeat(64), metadata: { proxyKey: "projects/" + doomed + "/assets/a.proxy.mp4" }, createdAt: "" });
    const del = (payload, id = doomed) => server.inject({ method: "DELETE", url: "/v1/projects/" + id, payload });

    assert.equal((await del({})).statusCode, 400, "needs the name typed back");
    assert.equal((await del({ confirmName: "My first" })).statusCode, 400);
    user = "editor";
    assert.equal((await del({ confirmName: "My first cut" })).statusCode, 403, "an editor cannot delete");
    user = "stranger";
    assert.equal((await del({ confirmName: "My first cut" })).statusCode, 404, "a stranger does not learn it exists");
    user = "owner";
    const ok = await del({ confirmName: "  my FIRST cut " });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().removedObjects, 3);
    assert.ok(files.every((f) => !existsSync(f)), "uploads, proxies and renders are gone");
    assert.ok(existsSync(safe), "another project's media is untouched");
    assert.equal((await server.inject({ method: "GET", url: "/v1/projects/" + doomed })).statusCode, 403);
    const list = (await server.inject({ method: "GET", url: "/v1/projects" })).json().projects.map((p) => p.name);
    assert.deepEqual(list, ["Keep me"]);
    // The name is free again.
    assert.equal((await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "My first cut" } })).statusCode, 201);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
