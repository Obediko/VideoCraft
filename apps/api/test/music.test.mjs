import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../dist/server.js";
import { registerTimelineRoutes } from "../dist/timeline-routes.js";
import { registerMusicRoutes } from "../dist/music-routes.js";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { LocalObjectStorage } from "@videocraft/storage";
import { ProjectService, InMemoryAssetRepository, InMemoryProjectMemberRepository, InMemoryProjectRepository, InMemoryRevisionRepository, InMemorySceneRepository } from "@videocraft/application";

test("generated music matches the cut's length and the brief's mood, and goes under the cut", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-genmusic-"));
  try {
    const projects = new InMemoryProjectRepository(); const assets = new InMemoryAssetRepository(); const revisions = new InMemoryRevisionRepository();
    let n = 0; const ids = { next: () => "id-" + ++n }; const clock = { now: () => new Date().toISOString() };
    const auth = { authenticate: async () => ({ userId: "u" }) }; const authorize = { canAccess: async () => true };
    const storage = new LocalObjectStorage(join(dir, "media"));
    const server = buildServer({ projects, assets, revisions, members: new InMemoryProjectMemberRepository(), scenes: new InMemorySceneRepository(), authenticate: auth, authorize, strategies: new StaticStrategyRegistry(), clock, ids });
    const service = new ProjectService(projects, assets, revisions, ids, clock);
    registerTimelineRoutes(server, { projects, revisions, assets, authenticate: auth.authenticate, authorize, saveRevision: (i) => service.saveRevision(i) });
    registerMusicRoutes(server, { assets, revisions, storage, authenticate: auth.authenticate, authorize, clock: clock.now });
    const projectId = (await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Music test" } })).json().project.id;
    await assets.save({ id: "talk", projectId, kind: "video", storageKey: "projects/" + projectId + "/assets/talk.media", checksumSha256: "a".repeat(64), metadata: {}, createdAt: clock.now() });
    const clip = (id, s, e, t) => ({ id, assetId: "talk", sourceStartUs: s, sourceEndUs: e, timelineStartUs: t, timelineEndUs: t + e - s });
    await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions", payload: { timeline: { durationUs: 20_000_000, tracks: [{ id: "v", kind: "video", clips: [clip("a", 0, 12_000_000, 0), clip("b", 30_000_000, 38_000_000, 12_000_000)] }] } } });

    const generate = (payload) => server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/music/generate", payload });
    assert.equal((await generate({ revision: 1, mood: "jazz" })).statusCode, 400);
    assert.equal((await generate({ revision: 9 })).statusCode, 404);
    const made = await generate({ revision: 1, mood: "auto", brief: { intent: "Inspire graduates to start their journey", audience: "students", channel: "short-form" } });
    assert.equal(made.statusCode, 201, made.body);
    const { asset, music } = made.json();
    assert.equal(music.mood, "inspiring", "mood inferred from the brief");
    assert.equal(asset.kind, "audio");
    assert.equal(asset.metadata.generated, true);
    assert.ok(Math.abs(asset.durationUs - 21_000_000) < 50_000, "cut length plus a second: " + asset.durationUs);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-of", "json", storage.resolve(asset.storageKey)]).toString());
    assert.ok(Math.abs(Number(probe.format.duration) - 21) < 0.05, "stored file decodes: " + probe.format.duration);

    const chosen = (await generate({ revision: 1, mood: "calm", seed: 4 })).json();
    assert.equal(chosen.music.mood, "calm");
    const edit = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions/1/edit", payload: { operations: [{ type: "set-music", assetId: asset.id, volumeDb: -16 }] } });
    assert.equal(edit.statusCode, 201, edit.body);
    assert.equal(edit.json().revision.timeline.tracks.find((t) => t.kind === "audio").clips[0].assetId, asset.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
