import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../dist/server.js";
import { registerTimelineRoutes } from "../dist/timeline-routes.js";
import { registerPreferenceRoutes } from "../dist/learning.js";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { ProjectService, InMemoryAssetRepository, InMemoryPreferenceRepository, InMemoryProjectMemberRepository, InMemoryProjectRepository, InMemoryRevisionRepository, InMemorySceneRepository } from "@videocraft/application";

const w = (text, s, e) => ({ text, startUs: Math.round(s * 1e6), endUs: Math.round(e * 1e6) });
function sentence(id, text, start) {
  const words = text.split(" ").map((t, i) => w(t, start + i * 0.4, start + i * 0.4 + 0.34));
  return { id, assetId: "asset-1", startUs: words[0].startUs, endUs: words.at(-1).endUs, text, words, provider: "test" };
}
const segments = [
  sentence("s1", "Why does customer onboarding fail for most new software teams?", 1),
  sentence("s2", "They ask for too many details before showing any value at all.", 8),
  sentence("s3", "Welcome back everybody to another casual chat stream today.", 16),
  sentence("s4", "Cut onboarding to three steps and activation will double quickly.", 24),
  sentence("s5", "Show the product working in the first minute with sample data.", 32),
  sentence("s6", "Anyway that is all for today thanks for watching everybody.", 44),
];

test("the highlight strategy learns from what a person removes, rejects and exports", async () => {
  const projects = new InMemoryProjectRepository();
  const assets = new InMemoryAssetRepository();
  const revisions = new InMemoryRevisionRepository();
  const preferences = new InMemoryPreferenceRepository();
  let n = 0;
  const ids = { next: () => "id-" + (++n) };
  let tick = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 9, 23, 0, 0, tick++)).toISOString() };
  const proposalValues = new Map();
  const renders = [];
  const auth = { authenticate: async () => ({ userId: "user-1" }) };
  const server = buildServer({
    projects, assets, revisions, members: new InMemoryProjectMemberRepository(), scenes: new InMemorySceneRepository(), preferences,
    authenticate: auth, authorize: { canAccess: async () => true }, strategies: new StaticStrategyRegistry(),
    transcripts: { listForAsset: async () => segments, replaceForAsset: async () => {} },
    proposals: { async save(p) { proposalValues.set(p.id, p); }, async get(id) { return proposalValues.get(id); }, async setStatus(id, status) { proposalValues.set(id, { ...proposalValues.get(id), status }); } },
    renderer: { async enqueue(input) { renders.push(input); return { id: "job-" + renders.length, projectId: input.project.id, revision: input.revision.revision, settings: input.settings, idempotencyKey: input.idempotencyKey, status: "queued", progress: 0 }; } },
    clock, ids,
  });
  const service = new ProjectService(projects, assets, revisions, ids, clock);
  registerTimelineRoutes(server, { projects, revisions, preferences, authenticate: auth.authenticate, authorize: { canAccess: async () => true }, saveRevision: (input) => service.saveRevision(input) });
  registerPreferenceRoutes(server, { preferences, authenticate: auth.authenticate });

  const projectId = (await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Learn" } })).json().project.id;
  await assets.save({ id: "asset-1", projectId, kind: "video", storageKey: "projects/" + projectId + "/assets/asset-1.media", checksumSha256: "a".repeat(64), metadata: {}, createdAt: clock.now() });
  await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions", payload: { timeline: { durationUs: 50_000_000, tracks: [{ id: "v", kind: "video", clips: [{ id: "orig", assetId: "asset-1", sourceStartUs: 0, sourceEndUs: 50_000_000, timelineStartUs: 0, timelineEndUs: 50_000_000 }] }] } } });
  const profile = { intent: "Explain why customer onboarding fails and how to fix it", audience: "software founders", channel: "short-form", targetDurationUs: 22_000_000, constraints: [] };
  const propose = async (revision) => (await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/proposals", payload: { revision, strategyId: "highlight-reel", profile } })).json().proposal;

  assert.equal((await server.inject({ url: "/v1/me/preferences" })).json().samples, 0);

  // 1. Reject a proposal: a weak negative for every clip in it.
  const first = await propose(1);
  assert.ok(first.operations.filter((o) => o.type === "insert-clip").every((o) => o.features && typeof o.features.relevance === "number"), "every suggested clip carries its feature scores");
  await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/proposals/" + first.id + "/decision", payload: { decision: "rejected" } });

  // 2. Accept the next one, remove a clip, and export the rest.
  const second = await propose(1);
  const accepted = (await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/proposals/" + second.id + "/decision", payload: { decision: "accepted" } })).json().revision;
  const clips = accepted.timeline.tracks.find((t) => t.kind === "video").clips;
  assert.ok(clips.length >= 2 && clips.every((clip) => clip.features), "accepted clips keep their features");
  const edited = (await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions/" + accepted.revision + "/edit", payload: { operations: [{ type: "remove-clip", clipId: clips[0].id }] } })).json().revision;
  const settings = { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1080, height: 1920, frameRate: 30 };
  assert.equal((await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/renders", payload: { revision: edited.revision, idempotencyKey: projectId + ":r:" + edited.revision, settings } })).statusCode, 202);
  // Exporting the same clips again does not double-count.
  await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/renders", payload: { revision: edited.revision, idempotencyKey: projectId + ":r2:" + edited.revision, settings } });

  const learned = (await server.inject({ url: "/v1/me/preferences" })).json();
  const kept = edited.timeline.tracks.find((t) => t.kind === "video").clips.length;
  assert.equal(learned.counts.removed, 1);
  assert.equal(learned.counts.exported, kept);
  assert.equal(learned.counts.rejected, first.operations.filter((o) => o.type === "insert-clip").length);
  assert.ok(Object.keys(learned.multipliers).length > 0, "multipliers learned: " + JSON.stringify(learned));
  assert.equal(typeof learned.summary, "string");

  // 3. The next proposal is made with the learned weights and says so when they matter.
  const third = await propose(1);
  const note = third.evidence.find((e) => e.reference === "learned-preferences");
  if (/favouring|de-emphasising/.test(learned.summary)) {
    assert.ok(note && /past edits/.test(note.excerpt), "learned weights are disclosed as evidence");
    assert.match(third.rationale, /Adjusted to your past edits/);
  }

  // 4. People can wipe what was learned.
  assert.equal((await server.inject({ method: "DELETE", url: "/v1/me/preferences" })).statusCode, 204);
  assert.equal((await server.inject({ url: "/v1/me/preferences" })).json().samples, 0);
  const fourth = await propose(1);
  assert.equal(fourth.evidence.some((e) => e.reference === "learned-preferences"), false);
});
