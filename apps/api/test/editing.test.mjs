import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../dist/server.js";
import { registerTimelineRoutes } from "../dist/timeline-routes.js";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { ProjectService, InMemoryAssetRepository, InMemoryProjectMemberRepository, InMemoryProjectRepository, InMemoryRevisionRepository, InMemorySceneRepository } from "@videocraft/application";

const w = (text, s, e) => ({ text, startUs: Math.round(s * 1e6), endUs: Math.round(e * 1e6) });
function sentence(id, text, start) {
  const words = text.split(" ").map((t, i) => w(t, start + i * 0.4, start + i * 0.4 + 0.34));
  return { id, assetId: "asset-1", startUs: words[0].startUs, endUs: words.at(-1).endUs, text, words, provider: "test" };
}
const segments = [
  sentence("s1", "Welcome back everybody to another casual chat stream.", 0.5),
  sentence("s2", "Why does customer onboarding fail for most new software teams?", 8),
  sentence("s3", "They ask for too many details before showing any value at all.", 14.5),
  sentence("s4", "Cut onboarding to three steps and activation will double.", 22),
  sentence("s5", "Anyway that is all for today thanks for watching everybody.", 40),
];

async function setup(overrides = {}) {
  const projects = new InMemoryProjectRepository();
  const assets = new InMemoryAssetRepository();
  const revisions = new InMemoryRevisionRepository();
  let n = 0;
  const ids = { next: () => "id-" + (++n) };
  const clock = { now: () => "2026-10-21T00:00:00.000Z" };
  const proposalValues = new Map();
  const deps = {
    projects, assets, revisions, members: new InMemoryProjectMemberRepository(), scenes: new InMemorySceneRepository(),
    authenticate: { authenticate: async () => ({ userId: "user-1" }) }, authorize: { canAccess: async () => true },
    strategies: new StaticStrategyRegistry(),
    transcripts: { listForAsset: async () => segments, replaceForAsset: async () => {} },
    proposals: { async save(p) { proposalValues.set(p.id, p); }, async get(id) { return proposalValues.get(id); }, async setStatus(id, status) { proposalValues.set(id, { ...proposalValues.get(id), status }); } },
    clock, ids, ...overrides,
  };
  const server = buildServer(deps);
  const service = new ProjectService(projects, assets, revisions, ids, clock);
  registerTimelineRoutes(server, { projects, revisions, authenticate: async () => ({ userId: "user-1" }), authorize: { canAccess: async () => true }, saveRevision: (input) => service.saveRevision(input) });
  const projectId = (await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Edit" } })).json().project.id;
  await assets.save({ id: "asset-1", projectId, kind: "video", storageKey: "projects/" + projectId + "/assets/asset-1.media", checksumSha256: "a".repeat(64), metadata: {}, createdAt: clock.now() });
  const saved = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions", payload: { timeline: { durationUs: 45_000_000, tracks: [{ id: "v", kind: "video", clips: [{ id: "orig", assetId: "asset-1", sourceStartUs: 0, sourceEndUs: 45_000_000, timelineStartUs: 0, timelineEndUs: 45_000_000 }] }] } } });
  assert.equal(saved.statusCode, 201);
  return { server, projectId };
}

test("highlight proposal -> accept -> edit -> caption correction produces consistent revisions", async () => {
  const { server, projectId } = await setup();
  const profile = { intent: "Show why customer onboarding fails and how to fix it", audience: "software teams", channel: "short-form", targetDurationUs: 25_000_000, constraints: [] };
  const preview = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/proposals", payload: { revision: 1, strategyId: "highlight-reel", profile } });
  assert.equal(preview.statusCode, 200, preview.body);
  const proposal = preview.json().proposal;
  assert.equal(proposal.strategyId, "highlight-reel");
  assert.ok(proposal.evidence.some((e) => e.source === "transcript" && /onboarding/i.test(e.excerpt) && e.endUs > e.startUs));

  const accepted = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/proposals/" + proposal.id + "/decision", payload: { decision: "accepted" } });
  assert.equal(accepted.statusCode, 201, accepted.body);
  const rev2 = accepted.json().revision;
  const video = rev2.timeline.tracks.find((t) => t.kind === "video").clips;
  assert.ok(video.length >= 1);
  assert.ok(video.every((c) => c.reason && c.score > 0));
  assert.ok(rev2.timeline.durationUs <= 28_000_000 && rev2.timeline.durationUs >= 8_000_000);
  const cues = rev2.timeline.tracks.find((t) => t.kind === "caption").clips;
  assert.ok(cues.length > 0 && !cues.some((c) => /casual chat|thanks for watching/i.test(c.transform.text)));

  // Edit: drop the first clip's tail, then correct a caption. Both go through the edit endpoint.
  const first = video[0];
  const edited = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions/2/edit", payload: { operations: [
    { type: "trim-clip", clipId: first.id, sourceStartUs: first.sourceStartUs, sourceEndUs: first.sourceEndUs - 500_000 },
    { type: "update-caption", clipId: cues[0].id, text: "Corrected caption text" },
  ] } });
  assert.equal(edited.statusCode, 201, edited.body);
  const rev3 = edited.json().revision;
  assert.equal(rev3.revision, 3);
  assert.equal(rev3.timeline.tracks.find((t) => t.kind === "caption").clips.some((c) => c.transform.text === "Corrected caption text"), true);
  assert.equal(rev3.timeline.durationUs, rev2.timeline.durationUs - 500_000);

  const stale = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions/2/edit", payload: { operations: [{ type: "remove-clip", clipId: first.id }] } });
  assert.equal(stale.statusCode, 409);
  const bad = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions/3/edit", payload: { operations: [{ type: "delete-everything" }] } });
  assert.equal(bad.statusCode, 400);
  const unknown = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions/3/edit", payload: { operations: [{ type: "remove-clip", clipId: "nope" }] } });
  assert.equal(unknown.statusCode, 400);
  await server.close();
});

test("silence from the detector is passed to the strategy and failures degrade gracefully", async () => {
  let calls = 0;
  const { server, projectId } = await setup({ silenceDetector: { detect: async () => { calls += 1; throw new Error("ffmpeg missing"); } } });
  const profile = { intent: "customer onboarding", audience: "founders", channel: "short-form", targetDurationUs: 25_000_000, constraints: [] };
  const preview = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/proposals", payload: { revision: 1, strategyId: "highlight-reel", profile } });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(calls, 1);
  await server.close();
});

test("render settings validate fit and caption style", async () => {
  const { server, projectId } = await setup({ renderer: { enqueue: async (input) => ({ id: "job", projectId, revision: 1, settings: input.settings, idempotencyKey: input.idempotencyKey, status: "queued", progress: 0 }) } });
  const base = { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1080, height: 1920, frameRate: 30 };
  const ok = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/renders", payload: { revision: 1, idempotencyKey: "key-12345678", settings: { ...base, fit: "cover", captionStyle: "bold-pop" } } });
  assert.equal(ok.statusCode, 202, ok.body);
  assert.equal(ok.json().job.settings.fit, "cover");
  const bad = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/renders", payload: { revision: 1, idempotencyKey: "key-12345679", settings: { ...base, fit: "stretch" } } });
  assert.equal(bad.statusCode, 400);
  await server.close();
});
