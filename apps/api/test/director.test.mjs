import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../dist/server.js";
import { registerDirectorRoutes } from "../dist/director-routes.js";
import { RuleDirector, OpenAiDirector } from "@videocraft/director";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { LocalObjectStorage } from "@videocraft/storage";
import { ProjectService, InMemoryAssetRepository, InMemoryProjectMemberRepository, InMemoryProjectRepository, InMemoryRevisionRepository, InMemorySceneRepository } from "@videocraft/application";

const lines = ["Most graduates discover the job market wants skills they never learned in class.", "So we built a programme with real projects and mentors for them.", "Students spend twelve weeks with companies and leave with a strong portfolio.", "More than half of them found jobs within three months last year.", "Start building something you can show to employers today."];

async function setup(director) {
  const dir = mkdtempSync(join(tmpdir(), "vc-director-"));
  const projects = new InMemoryProjectRepository(); const assets = new InMemoryAssetRepository(); const revisions = new InMemoryRevisionRepository();
  let n = 0; const ids = { next: () => "id-" + ++n }; const clock = { now: () => new Date().toISOString() };
  const auth = { authenticate: async () => ({ userId: "u" }) }; const authorize = { canAccess: async () => true };
  const storage = new LocalObjectStorage(join(dir, "media"));
  const segments = []; let t = 0.5;
  for (const [i, text] of lines.entries()) { const words = text.split(" ").map((w, j) => ({ text: w, startUs: Math.round((t + j * 0.36) * 1e6), endUs: Math.round((t + j * 0.36 + 0.3) * 1e6) })); segments.push({ id: "s" + i, assetId: "talk", startUs: words[0].startUs, endUs: words.at(-1).endUs, text, words, provider: "test" }); t = words.at(-1).endUs / 1e6 + 0.9; }
  const durationUs = Math.round((t + 1) * 1e6);
  const server = buildServer({ projects, assets, revisions, members: new InMemoryProjectMemberRepository(), scenes: new InMemorySceneRepository(), authenticate: auth, authorize, strategies: new StaticStrategyRegistry(), clock, ids });
  const service = new ProjectService(projects, assets, revisions, ids, clock);
  registerDirectorRoutes(server, { projects, assets, revisions, storage, transcripts: { listForAsset: async (id) => (id === "talk" ? segments : []) }, director, saveRevision: (i) => service.saveRevision(i), authenticate: auth.authenticate, authorize, clock: clock.now });
  const projectId = (await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Director" } })).json().project.id;
  const video = join(dir, "talk.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=" + (durationUs / 1e6).toFixed(2) + ":r=25", "-pix_fmt", "yuv420p", video]);
  const stored = await storage.putFile(video, "projects/" + projectId + "/assets/talk.media");
  await assets.save({ id: "talk", projectId, kind: "video", storageKey: stored.key, checksumSha256: stored.checksumSha256, durationUs, metadata: { filename: "talk.mp4", width: 640, height: 360 }, createdAt: clock.now() });
  await assets.save({ id: "pic", projectId, kind: "image", storageKey: "projects/" + projectId + "/assets/pic.media", checksumSha256: "b".repeat(64), metadata: { filename: "campus.jpg" }, createdAt: clock.now() });
  await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions", payload: { timeline: { durationUs, tracks: [{ id: "v", kind: "video", clips: [{ id: "src", assetId: "talk", sourceStartUs: 0, sourceEndUs: durationUs, timelineStartUs: 0, timelineEndUs: durationUs }] }] } } });
  return { server, projectId, segments, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("director (built-in rules): describe → plan → accept → a finished edit with cut, captions, title, music and format", async () => {
  const { server, projectId, close } = await setup(new RuleDirector());
  try {
    const url = (p) => "/v1/projects/" + projectId + "/director/" + p;
    assert.equal((await server.inject({ method: "POST", url: url("plan"), payload: { revision: 1, brief: "" } })).statusCode, 400);
    const planned = await server.inject({ method: "POST", url: url("plan"), payload: { revision: 1, brief: "A 20 second inspiring TikTok for new graduates about our mentoring programme" } });
    assert.equal(planned.statusCode, 200, planned.body);
    const { plan } = planned.json();
    assert.equal(plan.source, "rules");
    const kinds = plan.suggestions.map((s) => s.kind);
    for (const k of ["cut", "title", "music", "progress", "platform"]) assert.ok(kinds.includes(k), "plan has " + k + ": " + kinds);
    const applied = await server.inject({ method: "POST", url: url("apply"), payload: { revision: 1, plan, accepted: plan.suggestions.map((s) => s.id) } });
    assert.equal(applied.statusCode, 201, applied.body);
    const { revision, platform, music } = applied.json();
    assert.equal(platform, "tiktok");
    assert.match(music.description, /^Inspiring/);
    const track = (k) => revision.timeline.tracks.find((t) => t.kind === k)?.clips ?? [];
    const kept = track("video").reduce((s, c) => s + c.sourceEndUs - c.sourceStartUs, 0) / 1e6;
    assert.ok(kept > 5 && kept <= 20 * 1.2, "about the 20 s asked for: " + kept);
    assert.ok(track("caption").length > 0, "captions rebuilt for the cut");
    assert.ok(track("overlay").some((c) => c.transform.role === "graphic") && track("overlay").some((c) => c.transform.role === "progress"));
    assert.equal(track("audio")[0].transform.role, "music");
    assert.equal(revision.tailoring.targetDurationUs, 20_000_000);
    // Applying again on the old revision is refused: the timeline moved on.
    assert.equal((await server.inject({ method: "POST", url: url("apply"), payload: { revision: 1, plan, accepted: [] } })).statusCode, 409);
  } finally { close(); }
});

test("director (OpenAI): real frames are sent, the AI plan is applied, foreign assets in a tampered plan are refused", async () => {
  let request;
  const mock = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => {
    request = JSON.parse(b);
    const text = request.input[0].content[0].text;
    const plan = { summary: "Open on the result.", profile: { intent: "Inspire graduates", audience: "graduates", channel: "short-form", tone: "inspiring", targetSeconds: 15 }, suggestions: [
      { id: "cut", kind: "cut", title: "Lead with the jobs result", reason: "Strongest hook.", segments: [{ startS: 15.5, endS: 19.5 }, { startS: 4.5, endS: 9 }], text: "", subtitle: "", atS: 0, durationS: 0, position: "", mood: "", assetId: "", mode: "", platform: "" },
      { id: "broll", kind: "broll", title: "Show the campus", reason: "The line mentions companies.", segments: [], text: "", subtitle: "", atS: 6, durationS: 2, position: "", mood: "", assetId: /pic \(image\)/.test(text) ? "pic" : "", mode: "pip", platform: "" },
      { id: "advice", kind: "advice", title: "Warmer light", reason: "Frames look cold.", segments: [], text: "", subtitle: "", atS: 0, durationS: 0, position: "", mood: "", assetId: "", mode: "", platform: "" },
    ] };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ output_text: JSON.stringify(plan) }));
  }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const { server, projectId, close } = await setup(new OpenAiDirector({ apiKey: "sk-test", model: "gpt-6.1-sol", endpoint: "http://127.0.0.1:" + mock.address().port + "/v1" }));
  try {
    const url = (p) => "/v1/projects/" + projectId + "/director/" + p;
    const { plan } = (await server.inject({ method: "POST", url: url("plan"), payload: { revision: 1, brief: "Short reel for graduates" } })).json();
    assert.equal(plan.source, "ai");
    const images = request.input[0].content.filter((p) => p.type === "input_image");
    assert.equal(images.length, 8, "eight frames sampled from the video");
    assert.ok(images.every((p) => p.image_url.startsWith("data:image/jpeg;base64,/9j/")), "real JPEG frames");
    assert.match(request.input[0].content[0].text, /Most graduates discover/);
    const tampered = { ...plan, suggestions: [...plan.suggestions, { id: "evil", kind: "broll", title: "x", reason: "x", assetId: "someone-elses", atS: 5, durationS: 2, mode: "full" }] };
    const applied = (await server.inject({ method: "POST", url: url("apply"), payload: { revision: 1, plan: tampered, accepted: ["cut", "broll", "evil", "advice"] } })).json();
    const overlays = applied.revision.timeline.tracks.find((t) => t.kind === "overlay").clips;
    assert.deepEqual(overlays.map((c) => c.assetId), ["pic"], "only the project's own image is placed");
    const video = applied.revision.timeline.tracks.find((t) => t.kind === "video").clips;
    assert.ok(video[0].sourceStartUs < video[1].sourceStartUs, "segments are kept in source order");
  } finally { close(); mock.close(); }
});
