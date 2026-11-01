import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../dist/server.js";
import { registerDirectorRoutes } from "../dist/director-routes.js";
import { registerTimelineRoutes } from "../dist/timeline-routes.js";
import { RuleDirector, OpenAiDirector } from "@videocraft/director";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { LocalObjectStorage } from "@videocraft/storage";
import { ProjectService, InMemoryAssetRepository, InMemoryProjectMemberRepository, InMemoryProjectRepository, InMemoryRevisionRepository, InMemorySceneRepository } from "@videocraft/application";

const lines = ["Most graduates discover the job market wants skills they never learned in class.", "So we built a programme with real projects and mentors for them.", "Students spend twelve weeks with companies and leave with a strong portfolio.", "More than half of them found jobs within three months last year.", "Start building something you can show to employers today."];

async function setup(director, options = {}) {
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
  registerDirectorRoutes(server, { projects, assets, revisions, storage, transcripts: { listForAsset: async (id) => (id === "talk" ? segments : []) }, director, saveRevision: (i) => service.saveRevision(i), authenticate: auth.authenticate, authorize, clock: clock.now, ...(options.extra ?? {}) });
  registerTimelineRoutes(server, { projects, revisions, assets, authenticate: auth.authenticate, authorize, saveRevision: (i) => service.saveRevision(i) });
  const projectId = (await server.inject({ method: "POST", url: "/v1/projects", payload: { name: "Director" } })).json().project.id;
  const video = join(dir, "talk.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=" + (durationUs / 1e6).toFixed(2) + ":r=25", ...(options.blackLead ? ["-vf", "drawbox=c=black:t=fill:enable='lt(t,2)'"] : []), "-pix_fmt", "yuv420p", video]);
  const stored = await storage.putFile(video, "projects/" + projectId + "/assets/talk.media");
  await assets.save({ id: "talk", projectId, kind: "video", storageKey: stored.key, checksumSha256: stored.checksumSha256, durationUs, metadata: { filename: "talk.mp4", width: 640, height: 360 }, createdAt: clock.now() });
  await assets.save({ id: "pic", projectId, kind: "image", storageKey: "projects/" + projectId + "/assets/pic.media", checksumSha256: "b".repeat(64), metadata: { filename: "campus.jpg" }, createdAt: clock.now() });
  await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions", payload: { timeline: { durationUs, tracks: [{ id: "v", kind: "video", clips: [{ id: "src", assetId: "talk", sourceStartUs: 0, sourceEndUs: durationUs, timelineStartUs: 0, timelineEndUs: durationUs }] }] } } });
  return { server, projectId, segments, durationUs, assets, storage, close: () => rmSync(dir, { recursive: true, force: true }) };
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
    assert.ok(track("audio").some((c) => c.transform.role === "music"), "music under the cut");
    // Effects from the plan: a look on every piece, alternate punch-ins, fades at the ends, a pop under the title.
    const pieces = track("video");
    assert.ok(pieces.every((c) => c.transform?.look === "warm"), "inspiring brief → warm look");
    assert.equal(pieces[0].transform.transitionIn, "dip-black"); assert.equal(pieces.at(-1).transform.transitionOut, "dip-black");
    if (pieces.length > 1) assert.equal(pieces[1].transform.zoom, "punch");
    assert.ok(track("audio").some((c) => c.transform.role === "sfx" && c.transform.kind === "pop"), "a pop when the title appears");
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

test("edit check: finds black picture, a clipped word, no captions; fixes apply and the re-check is clean of them", async () => {
  const { server, projectId, segments, close } = await setup(new RuleDirector(), { blackLead: true });
  try {
    const url = (p) => "/v1/projects/" + projectId + "/director/" + p;
    const cutUs = segments[1].words[3].startUs + 100_000; // inside a word
    const saved = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions", payload: { timeline: { durationUs: cutUs, tracks: [{ id: "v", kind: "video", clips: [{ id: "src", assetId: "talk", sourceStartUs: 0, sourceEndUs: cutUs, timelineStartUs: 0, timelineEndUs: cutUs }] }] } } });
    const rev = saved.json().revision.revision;
    const checked = await server.inject({ method: "POST", url: url("check"), payload: { revision: rev, platform: "tiktok" } });
    assert.equal(checked.statusCode, 200, checked.body);
    const { issues, scanned, ai } = checked.json();
    assert.equal(scanned, true); assert.equal(ai, false);
    const kinds = issues.map((i) => i.kind);
    for (const k of ["black", "mid-word", "no-captions"]) assert.ok(kinds.includes(k), k + " in " + kinds);
    const black = issues.find((i) => i.kind === "black");
    assert.ok(black.atS < 0.3 && /Black screen for (1\.[6-9]|2(\.\d)?) s/.test(black.title), black.title);
    const fixes = issues.filter((i) => i.fix).map((i) => ({ title: i.title, atS: i.atS, operations: i.fix.operations }));
    const fixed = await server.inject({ method: "POST", url: url("fix"), payload: { revision: rev, fixes } });
    assert.equal(fixed.statusCode, 201, fixed.body);
    assert.equal(fixed.json().skipped.length, 0, "all fixes applied: " + fixed.json().skipped);
    const again = (await server.inject({ method: "POST", url: url("check"), payload: { revision: fixed.json().revision.revision, platform: "tiktok" } })).json().issues.map((i) => i.kind);
    for (const k of ["black", "mid-word", "no-captions"]) assert.ok(!again.includes(k), k + " fixed, now: " + again);
    // A fix from someone else's project media is refused.
    const evil = await server.inject({ method: "POST", url: url("fix"), payload: { revision: fixed.json().revision.revision, fixes: [{ title: "x", operations: [{ type: "insert-clip", assetId: "not-mine", sourceStartUs: 0, sourceEndUs: 1_000_000, reason: "x" }] }] } });
    assert.equal(evil.statusCode, 409);
  } finally { close(); }
});

test("edit check with the AI second look: frames of the edit are sent, its fixes become real operations", async () => {
  let review;
  const mock = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => {
    const body = JSON.parse(b); review = body;
    const result = { issues: [
      { title: "Open on the result", detail: "The jobs line is the hook.", atS: 4, severity: "fix", action: "move-piece", piece: 1, toIndex: 0, graphic: -1, text: "" },
      { title: "Clearer title", detail: "Say who it is for.", atS: 0, severity: "fix", action: "rewrite-text", piece: -1, toIndex: -1, graphic: 0, text: "For new graduates" },
      { title: "Background is cluttered", detail: "Film against a plain wall.", atS: 1, severity: "warn", action: "none", piece: -1, toIndex: -1, graphic: -1, text: "" },
      { title: "Bad index", detail: "", atS: 0, severity: "fix", action: "remove-piece", piece: 9, toIndex: -1, graphic: -1, text: "" },
    ] };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ output_text: JSON.stringify(result) }));
  }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const { server, projectId, segments, close } = await setup(new OpenAiDirector({ apiKey: "sk-test", model: "m", endpoint: "http://127.0.0.1:" + mock.address().port + "/v1" }));
  try {
    const url = (p) => "/v1/projects/" + projectId + "/director/" + p;
    const a = segments[1]; const b = segments[3];
    const piece = (id, seg, at) => ({ id, assetId: "talk", sourceStartUs: seg.startUs - 100_000, sourceEndUs: seg.endUs + 100_000, timelineStartUs: at, timelineEndUs: at + seg.endUs - seg.startUs + 200_000 });
    const p1 = piece("p1", a, 0); const p2 = piece("p2", b, p1.timelineEndUs);
    const tl = { durationUs: p2.timelineEndUs, tracks: [{ id: "v", kind: "video", clips: [p1, p2] }] };
    const first = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions", payload: { timeline: tl } }); assert.equal(first.statusCode, 201, first.body);
    let rev = first.json().revision.revision;
    rev = (await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions/" + rev + "/edit", payload: { operations: [{ type: "add-graphic", kind: "title", text: "Our programme", anchorAssetId: "talk", anchorSourceUs: a.startUs, durationUs: 2_500_000 }] } })).json().revision.revision;
    const result = (await server.inject({ method: "POST", url: url("check"), payload: { revision: rev, platform: "youtube", brief: "Reel for graduates" } })).json();
    assert.equal(result.ai, true, JSON.stringify(result));
    assert.equal(review.text.format.name, "edit_review");
    const text = review.input[0].content[0].text;
    assert.match(text, /#0 \[0\.0-/); assert.match(text, /#1 .*More than half/); assert.match(text, /title at 0\.\d s .*: Our programme/);
    const labels = review.input[0].content.filter((c) => c.type === "input_text").map((c) => c.text).join(" | ");
    assert.match(labels, /Start of piece #1/); assert.match(labels, /Under on-screen text #0/);
    assert.equal(review.input[0].content.filter((c) => c.type === "input_image").length, 3);
    const aiIssues = result.issues.filter((i) => i.source === "ai");
    assert.equal(aiIssues.length, 4);
    assert.deepEqual(aiIssues.find((i) => i.title === "Open on the result").fix.operations, [{ type: "reorder-clips", clipIds: ["p2", "p1"] }]);
    assert.equal(aiIssues.find((i) => i.title === "Bad index").fix, undefined, "an out-of-range piece gets no fix");
    const fixes = aiIssues.filter((i) => i.fix).map((i) => ({ title: i.title, atS: i.atS, operations: i.fix.operations }));
    const fixed = (await server.inject({ method: "POST", url: url("fix"), payload: { revision: rev, fixes } })).json();
    const order = fixed.revision.timeline.tracks.find((t) => t.kind === "video").clips.sort((x, y) => x.timelineStartUs - y.timelineStartUs).map((c) => c.id);
    assert.deepEqual(order, ["p2", "p1"]);
    assert.equal(fixed.revision.timeline.tracks.find((t) => t.kind === "overlay").clips[0].transform.text, "For new graduates");
  } finally { close(); mock.close(); }
});

test("ask for a change (built-in rules): shorter + black and white, applied without changing the description", async () => {
  const { server, projectId, close } = await setup(new RuleDirector());
  try {
    const url = (p) => "/v1/projects/" + projectId + "/director/" + p;
    const first = (await server.inject({ method: "POST", url: url("plan"), payload: { revision: 1, brief: "A 30 second inspiring Reel for graduates" } })).json().plan;
    const applied = (await server.inject({ method: "POST", url: url("apply"), payload: { revision: 1, plan: first, accepted: first.suggestions.map((s) => s.id) } })).json();
    const rev = applied.revision.revision;
    assert.equal((await server.inject({ method: "POST", url: url("ask"), payload: { revision: rev, instruction: "" } })).statusCode, 400);
    const asked = await server.inject({ method: "POST", url: url("ask"), payload: { revision: rev, instruction: "make it 10 seconds and black and white" } });
    assert.equal(asked.statusCode, 200, asked.body);
    const { plan } = asked.json();
    assert.deepEqual(plan.suggestions.map((s) => s.kind).sort(), ["cut", "look"]);
    const changed = (await server.inject({ method: "POST", url: url("apply"), payload: { revision: rev, plan, accepted: plan.suggestions.map((s) => s.id), keepTailoring: true } })).json().revision;
    const pieces = changed.timeline.tracks.find((t) => t.kind === "video").clips;
    const kept = pieces.reduce((s, c) => s + c.sourceEndUs - c.sourceStartUs, 0) / 1e6;
    assert.ok(kept <= 10 * 1.2, "about 10 s: " + kept);
    assert.ok(pieces.every((c) => c.transform?.look === "mono"));
    assert.equal(changed.tailoring.intent, applied.revision.tailoring.intent, "the description is kept");
    const nothing = (await server.inject({ method: "POST", url: url("ask"), payload: { revision: changed.revision, instruction: "add my logo in the corner" } })).json().plan;
    assert.equal(nothing.suggestions[0].kind, "advice", "what the rules cannot do is said plainly");
  } finally { close(); }
});

test("ask → apply: free stock behind you and a typed voice-over are made on the server; missing services are explained", async () => {
  const made = [];
  const { server, projectId, close } = await setup(new RuleDirector(), { extra: {
    findStock: async (_p, query, kind) => { made.push("stock:" + query + ":" + kind); return { id: "pic" }; },
    speak: async (_p, text) => { made.push("voice:" + text); return { id: "pic", durationUs: 2_000_000 }; },
  } });
  try {
    const url = (p) => "/v1/projects/" + projectId + "/director/" + p;
    const asked = (await server.inject({ method: "POST", url: url("ask"), payload: { revision: 1, instruction: "add a clip of a city at night behind me", playheadS: 6 } })).json().plan;
    assert.equal(asked.suggestions[0].kind, "stock");
    const applied = await server.inject({ method: "POST", url: url("apply"), payload: { revision: 1, plan: asked, accepted: [asked.suggestions[0].id], keepTailoring: true } });
    assert.equal(applied.statusCode, 201, applied.body);
    const broll = applied.json().revision.timeline.tracks.find((t) => t.kind === "overlay").clips.find((c) => c.transform.role === "broll");
    assert.equal(broll.transform.mode, "behind"); assert.equal(broll.assetId, "pic");
    assert.deepEqual(made, ["stock:city at night:video"]);
    const voice = (await server.inject({ method: "POST", url: url("ask"), payload: { revision: 2, instruction: "add a voice-over \"Welcome to the course\"" } })).json().plan;
    const withVoice = await server.inject({ method: "POST", url: url("apply"), payload: { revision: 2, plan: voice, accepted: [voice.suggestions[0].id], keepTailoring: true } });
    assert.equal(withVoice.statusCode, 201, withVoice.body);
    assert.ok(withVoice.json().revision.timeline.tracks.find((t) => t.kind === "audio").clips.some((c) => c.transform.role === "voiceover"));
  } finally { close(); }
  const bare = await setup(new RuleDirector());
  try {
    const url = (p) => "/v1/projects/" + bare.projectId + "/director/" + p;
    const asked = (await bare.server.inject({ method: "POST", url: url("ask"), payload: { revision: 1, instruction: "add a gif of applause" } })).json().plan;
    const applied = (await bare.server.inject({ method: "POST", url: url("apply"), payload: { revision: 1, plan: asked, accepted: [asked.suggestions[0].id] } })).json();
    assert.match(applied.notes[0], /not set up/);
  } finally { bare.close(); }
});

test("stock ideas come with the found picture, and applying adds exactly that one", async () => {
  const imported = [];
  const plan = { summary: "x", profile: { intent: "x", audience: "", channel: "short-form", tone: "", targetSeconds: 20 }, source: "ai", suggestions: [
    { id: "s1", kind: "stock", title: "Students", reason: "Words describe students", query: "students studying", assetKind: "video", atS: 3, durationS: 3, mode: "full" },
    { id: "s2", kind: "stock", title: "Nothing", reason: "x", query: "zzz unmatched", assetKind: "photo", atS: 4, durationS: 3, mode: "full" },
  ] };
  const director = { plan: async () => plan, ask: async () => plan };
  const { server, projectId, close } = await setup(director, { extra: {
    previewStock: async (query) => (query.startsWith("students") ? { provider: "pexels", id: "123", thumbUrl: "https://images.pexels.com/123.jpg", credit: "Ana on Pexels" } : undefined),
    importStock: async (_p, provider, kind, id) => { imported.push(provider + ":" + kind + ":" + id); return { id: "pic" }; },
    findStock: async () => { throw new Error("should use the shown pick"); },
  } });
  try {
    const url = (p) => "/v1/projects/" + projectId + "/director/" + p;
    const got = (await server.inject({ method: "POST", url: url("plan"), payload: { revision: 1, brief: "A reel for graduates" } })).json().plan;
    assert.deepEqual(got.suggestions.map((s) => s.id), ["s1"], "an idea with no picture found is not offered");
    assert.equal(got.suggestions[0].pick.thumbUrl, "https://images.pexels.com/123.jpg");
    const applied = await server.inject({ method: "POST", url: url("apply"), payload: { revision: 1, plan: got, accepted: ["s1"] } });
    assert.equal(applied.statusCode, 201, applied.body);
    assert.deepEqual(imported, ["pexels:video:123"]);
    assert.ok(applied.json().revision.timeline.tracks.find((t) => t.kind === "overlay").clips.some((c) => c.assetId === "pic"));
  } finally { close(); }
});

test('after-video narration appends a real end-card asset and keeps the full audio duration', async () => {
  const voiceDir = mkdtempSync(join(tmpdir(), 'vc-outro-audio-'));
  const state = await setup(new RuleDirector(), { extra: {
    speak: async (projectId) => {
      const path = join(voiceDir, 'voice.wav');
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=1100:duration=2', path]);
      const stored = await state.storage.putFile(path, 'projects/' + projectId + '/assets/narration.media');
      await state.assets.save({ id: 'narration', projectId, kind: 'audio', durationUs: 2_000_000, storageKey: stored.key, checksumSha256: stored.checksumSha256, metadata: { hasAudio: true }, createdAt: new Date().toISOString() });
      return { id: 'narration', durationUs: 2_000_000 };
    },
  } });
  const { server, projectId, durationUs, close } = state;
  try {
    const root = '/v1/projects/' + projectId + '/director/';
    const asked = await server.inject({ method: 'POST', url: root + 'ask', payload: { revision: 1, instruction: 'Add a voice-over after the video (Jesus truly saves)' } });
    const plan = asked.json().plan;
    const voice = plan.suggestions.find(s => s.kind === 'voiceover');
    assert.equal(voice.afterVideo, true);
    const applied = await server.inject({ method: 'POST', url: root + 'apply', payload: { revision: 1, plan, accepted: [voice.id], keepTailoring: true } });
    assert.equal(applied.statusCode, 201, applied.body);
    const result = applied.json();
    assert.equal(result.notes, undefined, applied.body);
    const timeline = result.revision.timeline;
    assert.equal(timeline.durationUs, durationUs + 2_000_000);
    const card = timeline.tracks.find(t => t.kind === 'video').clips.at(-1);
    assert.equal(card.timelineStartUs, durationUs);
    const vo = timeline.tracks.flatMap(t => t.clips).find(c => c.transform?.role === 'voiceover');
    assert.equal(vo.timelineStartUs, durationUs);
    assert.equal(vo.timelineEndUs - vo.timelineStartUs, 2_000_000);
    assert.ok(timeline.tracks.flatMap(t => t.clips).some(c => c.transform?.text === 'Jesus truly saves' && c.timelineStartUs === durationUs));
    const { FfmpegCommandPlanner, FfmpegProcess } = await import('@videocraft/rendering');
    const media = new Map((await state.assets.listForProject(projectId)).map(a => [a.id, a]));
    const planner = new FfmpegCommandPlanner({ resolve: async id => state.storage.resolve(media.get(id).storageKey), hasAudio: async id => media.get(id).metadata.hasAudio === true });
    const out = join(voiceDir, 'outro-render.mp4');
    await new FfmpegProcess().run(await planner.plan(result.revision, { format: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', width: 320, height: 180, frameRate: 30 }, out));
    execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']);
    const tail = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(durationUs / 1e6 + 0.2), '-i', out, '-t', '1', '-vn', '-f', 's16le', '-']);
    assert.ok(tail.length > 1000 && tail.some(byte => byte !== 0), 'narration remains audible AFTER the original video');
    const outputDuration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
    assert.ok(Math.abs(outputDuration - timeline.durationUs / 1e6) < 0.1);

  } finally { close(); rmSync(voiceDir, { recursive: true, force: true }); }
});

test("a storyboard readability fix applies to an owned photo and resolves its finding", async () => {
  const { server, projectId, close } = await setup(new RuleDirector());
  try {
    const timeline = { durationUs: 3_000_000, tracks: [{ id: "video", kind: "video", clips: [{ id: "photo-part", assetId: "pic", sourceStartUs: 0, sourceEndUs: 3_000_000, timelineStartUs: 0, timelineEndUs: 3_000_000 }] }, { id: "graphics", kind: "overlay", clips: [{ id: "title", assetId: "generated:graphic", sourceStartUs: 0, sourceEndUs: 1_000_000, timelineStartUs: 2_000_000, timelineEndUs: 3_000_000, transform: { role: "graphic", kind: "title", text: "Choose Freedom", position: "center", anchorAssetId: "pic", anchorClipId: "photo-part", anchorSourceUs: 2_000_000, durationUs: 1_000_000 } }] }] };
    const saved = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/revisions", payload: { timeline, tailoring: { intent: "Story", audience: "", channel: "tiktok", targetDurationUs: 3e6, constraints: ["creation:story"] } } });
    assert.equal(saved.statusCode, 201, saved.body);
    const checked = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/director/check", payload: { revision: 2 } });
    assert.equal(checked.statusCode, 200, checked.body);
    const issue = checked.json().issues.find(i => i.kind === "too-fast"); assert.ok(issue?.fix);
    const fixed = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/director/fix", payload: { revision: 2, fixes: [{ title: issue.title, atS: issue.atS, operations: issue.fix.operations }] } });
    assert.equal(fixed.statusCode, 201, fixed.body); assert.equal(fixed.json().applied.length, 1, fixed.body);
    const final = await server.inject({ method: "POST", url: "/v1/projects/" + projectId + "/director/check", payload: { revision: fixed.json().revision.revision } });
    assert.equal(final.json().issues.some(i => i.kind === "too-fast"), false);
  } finally { close(); }
});

test('accepting a creative Director suggestion saves a reusable recipe after the edit succeeds',async()=>{
  const saved=[];const library={list:async()=>[],save:async(userId,e)=>saved.push({userId,...e}),remove:async()=>{}};
  const state=await setup(new RuleDirector(),{extra:{effects:library}});
  try{
    const plan={source:'ai',summary:'A quiet emphasis',suggestions:[{id:'effect',kind:'effect',presetId:'key-point',text:'Real projects',atS:1,durationS:2}]};
    const r=await state.server.inject({method:'POST',url:'/v1/projects/'+state.projectId+'/director/apply',payload:{revision:1,plan,accepted:['effect']}});
    assert.equal(r.statusCode,201,r.body);assert.equal(saved.length,1);assert.equal(saved[0].userId,'u');assert.equal(saved[0].recipe.text,'Real projects');
    assert.ok(r.json().revision.timeline.tracks.flatMap(t=>t.clips).some(c=>c.transform?.text==='Real projects'));
    const stale=await state.server.inject({method:'POST',url:'/v1/projects/'+state.projectId+'/director/apply',payload:{revision:1,plan,accepted:['effect']}});assert.equal(stale.statusCode,409);assert.equal(saved.length,1);
  }finally{await state.server.close();state.close();}
});

test('AI review samples end-card graphics from the end-card asset instead of original source zero',async()=>{
  let seen;const director={plan:new RuleDirector().plan,review:async input=>{seen=input;return [];}};
  const state=await setup(director);
  try{
    const cardKey='projects/'+state.projectId+'/assets/end-card.mp4';const path=state.storage.resolve(cardKey);
    const {mkdirSync}=await import('node:fs');const {dirname}=await import('node:path');mkdirSync(dirname(path),{recursive:true});
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0x1F2A24:s=160x240:r=15:d=2','-c:v','libx264','-pix_fmt','yuv420p',path]);
    await state.assets.save({id:'end-card',projectId:state.projectId,kind:'video',storageKey:cardKey,checksumSha256:'c'.repeat(64),durationUs:2e6,metadata:{endCard:true},createdAt:new Date().toISOString()});
    const durationUs=state.durationUs;
    const timeline={durationUs:durationUs+2e6,tracks:[{id:'v',kind:'video',clips:[{id:'talk-piece',assetId:'talk',sourceStartUs:0,sourceEndUs:durationUs,timelineStartUs:0,timelineEndUs:durationUs},{id:'card-piece',assetId:'end-card',sourceStartUs:0,sourceEndUs:2e6,timelineStartUs:durationUs,timelineEndUs:durationUs+2e6}]},{id:'graphics',kind:'overlay',clips:[{id:'closing',assetId:'generated:graphic',sourceStartUs:0,sourceEndUs:2e6,timelineStartUs:durationUs,timelineEndUs:durationUs+2e6,transform:{role:'graphic',kind:'title',text:'Jesus truly saves',anchorAssetId:'end-card',anchorClipId:'card-piece',anchorSourceUs:0,durationUs:2e6}}]}]};
    const saved=await state.server.inject({method:'POST',url:'/v1/projects/'+state.projectId+'/revisions',payload:{timeline}});assert.equal(saved.statusCode,201,saved.body);
    const checked=await state.server.inject({method:'POST',url:'/v1/projects/'+state.projectId+'/director/check',payload:{revision:2}});assert.equal(checked.statusCode,200,checked.body);
    const frame=seen.frames.find(f=>f.label.startsWith('Under on-screen text #0'));assert.ok(frame,'closing frame must be sampled');
    const rgb=execFileSync('ffmpeg',['-v','error','-i','pipe:0','-vf','scale=1:1','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{input:Buffer.from(frame.jpegBase64,'base64')});
    [31,42,36].forEach((v,i)=>assert.ok(Math.abs(rgb[i]-v)<10,`card colour channel ${i}: ${rgb[i]}`));
    assert.equal(frame.atS,durationUs/1e6);assert.match(seen.pieces[1].text,/Intentional narrated end card: Jesus truly saves/);
  }finally{await state.server.close();state.close();}
});

test('accepted sourced visuals add provider recipes to the library after the revision is saved',async()=>{
  const saved=[];const state=await setup(new RuleDirector(),{extra:{effects:{list:async()=>[],save:async(uid,e)=>saved.push({uid,...e}),remove:async()=>{}},importStock:async()=>({id:'pic'})}});
  try{
    const plan={source:'ai',suggestions:[{id:'stock',kind:'stock',query:'campus gardens',assetKind:'photo',atS:1,durationS:3,mode:'pip',pick:{provider:'pexels',id:'11',thumbUrl:'https://images.pexels.com/11.jpg'}}]};
    const r=await state.server.inject({method:'POST',url:'/v1/projects/'+state.projectId+'/director/apply',payload:{revision:1,plan,accepted:['stock']}});
    assert.equal(r.statusCode,201,r.body);assert.equal(saved.length,1);assert.equal(saved[0].uid,'u');assert.deepEqual(saved[0].recipe.stock,{provider:'pexels',id:'11',kind:'photo',mode:'pip'});
  }finally{await state.server.close();state.close();}
});
