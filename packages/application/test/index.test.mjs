import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryAssetRepository,
  InMemoryProjectRepository,
  InMemoryRevisionRepository,
  ProjectService
} from "../dist/index.js";

const clock = { now: () => "2026-10-21T00:00:00.000Z" };
const ids = { next: (() => { let n = 0; return () => "id-" + (++n); })() };

function service() {
  return new ProjectService(
    new InMemoryProjectRepository(),
    new InMemoryAssetRepository(),
    new InMemoryRevisionRepository(),
    ids,
    clock
  );
}

test("creates a project and advances immutable revisions", async () => {
  const projects = new InMemoryProjectRepository();
  const revisions = new InMemoryRevisionRepository();
  const app = new ProjectService(projects, new InMemoryAssetRepository(), revisions, ids, clock);
  const project = await app.createProject({ ownerId: "owner-1", name: " Demo " });
  const revision = await app.saveRevision({
    projectId: project.id,
    createdBy: project.ownerId,
    timeline: { durationUs: 100, tracks: [] }
  });
  assert.equal(project.name, "Demo");
  assert.equal(revision.revision, 1);
  assert.equal((await projects.get(project.id)).revision, 1);
  assert.equal((await revisions.get(project.id, 1)).revision, 1);
});

test("rejects assets for missing projects", async () => {
  await assert.rejects(() => service().addAsset({
    id: "asset-1",
    projectId: "missing",
    kind: "video",
    storageKey: "uploads/video.mp4",
    checksumSha256: "a".repeat(64),
    metadata: {},
    createdAt: clock.now()
  }), /Project not found/);
});


test("renames a project with the same validation as creation", async () => {
  const projects = new InMemoryProjectRepository();
  const app = new ProjectService(projects, new InMemoryAssetRepository(), new InMemoryRevisionRepository(), ids, clock);
  const project = await app.createProject({ ownerId: "owner-rename", name: "Before" });
  const renamed = await app.renameProject(project.id, " After ");
  assert.equal(renamed.name, "After");
  assert.equal((await projects.get(project.id)).name, "After");
  await assert.rejects(() => app.renameProject(project.id, "   "), /required/);
});


test("rejects assets whose storage key belongs to another project", async () => {
  const projects = new InMemoryProjectRepository();
  const app = new ProjectService(projects, new InMemoryAssetRepository(), new InMemoryRevisionRepository(), ids, clock);
  const project = await app.createProject({ ownerId: "owner-scope", name: "Scoped" });
  await assert.rejects(() => app.addAsset({
    id: "asset-cross-project",
    projectId: project.id,
    kind: "video",
    storageKey: "projects/other-project/assets/source.media",
    checksumSha256: "b".repeat(64),
    metadata: {},
    createdAt: clock.now()
  }), /scoped to the project/);
});
