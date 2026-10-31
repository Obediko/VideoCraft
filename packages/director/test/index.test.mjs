import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { applyTimelineOperations } from "@videocraft/domain";
import { OpenAiDirector, RuleDirector, briefHints, planOperations, sanitizePlan } from "../dist/index.js";

const sentences = ["Most graduates discover the job market wants skills they never learned.", "So we built a programme with real projects and mentors.", "Hi I'm Ada and I run the programme at EDI.", "Students spend twelve weeks with companies and leave with a portfolio.", "More than half found jobs within three months.", "Start building something you can show today."];
const words = []; const transcript = []; let t = 0.5;
for (const s of sentences) { const ws = s.split(" ").map((w, i) => ({ text: w, startUs: Math.round((t + i * 0.36) * 1e6), endUs: Math.round((t + i * 0.36 + 0.3) * 1e6) })); words.push(...ws); transcript.push({ startS: t, endS: ws.at(-1).endUs / 1e6, text: s }); t = ws.at(-1).endUs / 1e6 + 0.8; }
const durationS = t + 1;
const input = { brief: "A 25 second inspiring reel for graduates on TikTok", durationS, frame: { width: 1080, height: 1920 }, transcript, candidates: transcript.map((s, i) => ({ id: "c" + i, startS: s.startS, endS: s.endS, text: s.text, score: [0.8, 0.5, 0.4, 0.75, 0.9, 0.7][i] })), frames: [{ atS: 1, jpegBase64: "AAAA" }, { atS: 10, jpegBase64: "BBBB" }], assets: [{ id: "img-1", kind: "image", name: "campus.jpg" }] };

test("brief hints: platform, length and mood from plain words", () => {
  assert.deepEqual(briefHints("A 25 second inspiring reel for graduates on TikTok"), { channel: "short-form", platform: "tiktok", targetSeconds: 25, mood: "inspiring" });
  assert.equal(briefHints("Long-form YouTube talk, 3 minutes").platform, "youtube");
  assert.equal(briefHints("A 20 second upbeat YouTube clip about onboarding").mood, "upbeat");
  assert.equal(briefHints("Spoken word poetry over soothing visuals").mood, "calm");
  assert.equal(briefHints("A clip about our product").mood, undefined, "no mood is guessed when none was asked for");
  assert.equal(briefHints("Long-form YouTube talk, 3 minutes").targetSeconds, 180);
  assert.equal(briefHints("a calm spoken word poem").mood, "calm");
});

test("plans are sanitised: foreign assets, bad times, overlaps and unknown kinds are dropped", () => {
  const plan = sanitizePlan({ summary: "x", profile: { intent: "i", audience: "a", channel: "short-form", tone: "", targetSeconds: 20 }, suggestions: [
    { id: "cut", kind: "cut", title: "Cut", reason: "r", segments: [{ startS: 0.5, endS: 4.9 }, { startS: 4, endS: 8 }, { startS: 30, endS: 34 }, { startS: 999, endS: 1000 }] },
    { id: "t", kind: "title", title: "T", reason: "r", text: "Your next job", atS: 1, durationS: 2.5, position: "top" },
    { id: "bad", kind: "title", title: "T", reason: "r", text: "Late", atS: 5000, durationS: 2 },
    { id: "b1", kind: "broll", title: "B", reason: "r", assetId: "img-1", atS: 12, durationS: 2, mode: "pip" },
    { id: "b2", kind: "broll", title: "B", reason: "r", assetId: "not-mine", atS: 12, durationS: 2, mode: "full" },
    { id: "m", kind: "music", title: "M", reason: "r", mood: "jazzy" },
    { id: "x", kind: "explode", title: "?", reason: "r" },
  ] }, input, "ai");
  const kinds = plan.suggestions.map((s) => s.id);
  assert.deepEqual(kinds, ["cut", "t", "b1"]);
  assert.deepEqual(plan.suggestions[0].segments.map((s) => [s.startS, s.endS]), [[0.5, 4.9]], "overlapping and out-of-range segments dropped");
});

test("the rules director makes a complete plan from the brief", async () => {
  const plan = await new RuleDirector().plan(input);
  assert.equal(plan.source, "rules");
  const cut = plan.suggestions.find((s) => s.kind === "cut");
  const total = cut.segments.reduce((sum, s) => sum + s.endS - s.startS, 0);
  assert.ok(total <= 25 * 1.15 && total > 5, "near the 25 s asked for: " + total);
  assert.equal(plan.suggestions.find((s) => s.kind === "music").mood, "inspiring");
  assert.equal(plan.suggestions.find((s) => s.kind === "platform").platform, "tiktok");
  assert.ok(plan.suggestions.some((s) => s.kind === "title"));
});

async function mockOpenAi(handler) {
  const requests = [];
  const server = createServer((req, res) => { let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => { requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); const [status, payload] = handler(JSON.parse(body)); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { endpoint: "http://127.0.0.1:" + server.address().port + "/v1", requests, close: () => new Promise((r) => server.close(r)) };
}

test("OpenAI director: frames go in as images, the strict schema is requested, and the answer becomes a plan", async () => {
  const answer = { summary: "Hook on the jobs number, then the programme.", profile: { intent: "Inspire graduates", audience: "graduates", channel: "short-form", tone: "inspiring", targetSeconds: 25 }, suggestions: [
    { id: "cut", kind: "cut", title: "Lead with the result", reason: "The jobs number is the strongest hook.", segments: [{ startS: transcript[4].startS, endS: transcript[4].endS }, { startS: transcript[1].startS, endS: transcript[1].endS }], text: "", subtitle: "", atS: 0, durationS: 0, position: "", mood: "", assetId: "", mode: "", platform: "" },
    { id: "lt", kind: "lower-third", title: "Name Ada", reason: "She introduces herself at 12 s.", segments: [], text: "Ada", subtitle: "Programme lead, EDI", atS: transcript[2].startS + 0.5, durationS: 3, position: "", mood: "", assetId: "", mode: "", platform: "" },
    { id: "adv", kind: "advice", title: "Soften the light", reason: "The frames show a harsh light from the left; face a window.", segments: [], text: "", subtitle: "", atS: 0, durationS: 0, position: "", mood: "", assetId: "", mode: "", platform: "" },
  ] };
  const mock = await mockOpenAi(() => [200, { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] }]);
  try {
    const plan = await new OpenAiDirector({ apiKey: "sk-test", model: "gpt-6.1-sol", endpoint: mock.endpoint }).plan(input);
    assert.equal(plan.source, "ai");
    assert.equal(plan.model, "gpt-6.1-sol");
    assert.deepEqual(plan.suggestions.map((s) => s.kind), ["cut", "lower-third", "advice"]);
    const req = mock.requests[0];
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.auth, "Bearer sk-test");
    assert.equal(req.body.text.format.type, "json_schema");
    assert.equal(req.body.text.format.strict, true);
    const images = req.body.input[0].content.filter((p) => p.type === "input_image");
    assert.deepEqual(images.map((p) => p.image_url), ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB"]);
    assert.match(req.body.input[0].content[0].text, /A 25 second inspiring reel/);
  } finally { await mock.close(); }
});

test("OpenAI director falls back to rules, and says why, on errors or unusable answers", async () => {
  const failing = await mockOpenAi(() => [404, { error: { message: "The model `gpt-6.1-sol` does not exist" } }]);
  try {
    const plan = await new OpenAiDirector({ apiKey: "sk-test", model: "gpt-6.1-sol", endpoint: failing.endpoint }).plan(input);
    assert.equal(plan.source, "rules");
    assert.match(plan.note, /unavailable \(OpenAI returned 404: The model `gpt-6.1-sol` does not exist\)/);
    assert.ok(plan.suggestions.some((s) => s.kind === "cut"));
  } finally { await failing.close(); }
  const empty = await mockOpenAi(() => [200, { output_text: JSON.stringify({ summary: "", profile: {}, suggestions: [] }) }]);
  try {
    const plan = await new OpenAiDirector({ apiKey: "sk-test", model: "m", endpoint: empty.endpoint }).plan(input);
    assert.match(plan.note, /no usable cut/);
  } finally { await empty.close(); }
});

test("applying a plan: words are not clipped, captions are rebuilt once, graphics land inside kept footage", async () => {
  const base = { durationUs: Math.round(durationS * 1e6), tracks: [{ id: "v", kind: "video", clips: [{ id: "src", assetId: "talk", sourceStartUs: 0, sourceEndUs: Math.round(durationS * 1e6), timelineStartUs: 0, timelineEndUs: Math.round(durationS * 1e6) }] }, { id: "c", kind: "caption", clips: [{ id: "old-cue", assetId: "talk", sourceStartUs: 600_000, sourceEndUs: 1_500_000, timelineStartUs: 600_000, timelineEndUs: 1_500_000, transform: { text: "old", sourceBound: true } }] }] };
  const plan = sanitizePlan({ summary: "s", profile: {}, suggestions: [
    { id: "cut", kind: "cut", title: "c", reason: "r", segments: [{ startS: transcript[4].startS + 0.1, endS: transcript[4].endS - 0.1 }, { startS: transcript[5].startS, endS: transcript[5].endS }] },
    { id: "t", kind: "title", title: "t", reason: "r", text: "Jobs in 3 months", atS: 1.0, durationS: 2 },
    { id: "skip", kind: "callout", title: "c", reason: "r", text: "not accepted", atS: transcript[5].startS, durationS: 1 },
    { id: "p", kind: "progress", title: "p", reason: "r" },
  ] }, input, "ai");
  const ops = planOperations(plan, new Set(["cut", "t", "p"]), { timeline: base, assetId: "talk", words });
  const result = applyTimelineOperations(base, ops);
  const video = result.tracks.find((tr) => tr.kind === "video").clips;
  assert.equal(video.length, 2);
  assert.ok(video[0].sourceStartUs <= Math.round(transcript[4].startS * 1e6), "the first word of the segment is kept whole");
  const cues = result.tracks.find((tr) => tr.kind === "caption").clips;
  assert.ok(cues.length > 0 && cues.every((c) => c.transform.text !== "old"), "old captions removed, new ones built");
  const overlays = result.tracks.find((tr) => tr.kind === "overlay").clips;
  const title = overlays.find((c) => c.transform.role === "graphic");
  assert.equal(title.transform.text, "Jobs in 3 months");
  assert.ok(title.timelineStartUs >= 0 && title.timelineStartUs < video[0].timelineEndUs, "a title asked for at 1 s (cut away) moves into the first kept segment");
  assert.ok(overlays.some((c) => c.transform.role === "progress"));
  assert.ok(!overlays.some((c) => c.transform.text === "not accepted"), "unaccepted suggestions are not applied");
});

test('creative treatments are bounded, grounded in retained footage and compile after a cut',async()=>{
  const {parseEffectRecipe}=await import('@videocraft/domain');
  const {effectOperations,sanitizePlan}=await import('../dist/index.js');
  const input={brief:'Explain thoughtfully',durationS:20,frame:{width:640,height:360},transcript:[],candidates:[],frames:[],assets:[]};
  const plan=sanitizePlan({suggestions:[{id:'good',kind:'effect',presetId:'chapter',text:'Next step',atS:10,durationS:2},{id:'too-close',kind:'effect',presetId:'thinking',atS:11},{id:'bad',kind:'effect',presetId:'download-code',atS:15}]},input,'ai');
  assert.equal(plan.suggestions.length,1);
  const timeline={durationUs:4e6,tracks:[{id:'v',kind:'video',clips:[{id:'kept',assetId:'a',sourceStartUs:10e6,sourceEndUs:14e6,timelineStartUs:0,timelineEndUs:4e6}]}]};
  const ops=effectOperations(plan,new Set(['good']),timeline,'a');assert.equal(ops.length,1);assert.equal(ops[0].anchorClipId,'kept');
  plan.suggestions[0].atS=8;assert.equal(effectOperations(plan,new Set(['good']),timeline,'a').length,0,'cut-away moments get no unrelated effect');
  const rules=await new RuleDirector().ask({...input,instruction:'add a quiet focus here',playheadS:10,current:{pieces:[{startS:10,endS:14,text:'reflect'}],graphics:[],look:'none',music:'none',seconds:4,extras:''}});
  assert.ok(rules.suggestions.some(s=>s.kind==='effect'&&s.recipe.presetId==='focus'));
});
