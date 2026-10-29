import test from "node:test";
import assert from "node:assert/strict";
import { RuleDirector, effectOperations, planOperations } from "../dist/index.js";

const input = {
  brief: "Reel for graduates", durationS: 60, frame: { width: 1080, height: 1920 },
  transcript: [{ startS: 1, endS: 8, text: "We built a mentoring programme." }, { startS: 9, endS: 25, text: "Half of them found jobs." }],
  candidates: [], frames: [], assets: [{ id: "office", kind: "image", name: "office.jpg" }],
  current: { pieces: [{ startS: 1, endS: 25, text: "We built … jobs." }], graphics: [], look: "none", music: "yes", seconds: 24 },
};
const ask = (instruction, extra = {}) => new RuleDirector().ask({ ...input, ...extra, instruction });
const kinds = (plan) => plan.suggestions.map((s) => s.kind + (s.target ? ":" + s.target : ""));

test("the built-in rules understand everything the editor can add, change or take out", async () => {
  const cases = [
    ["The background volume is higher than the main", ["volume:music"]],
    ["the music is too loud", ["volume:music"]],
    ["make the sound effects quieter", ["volume:sfx"]],
    ["remove the music", ["remove:music"]],
    ["remove the background music", ["remove:music"]],
    ["get rid of all the sound effects", ["remove:sfx"]],
    ["no more progress bar", ["remove:progress"]],
    ["delete the titles", ["remove:graphics"]],
    ["remove the cutaways", ["remove:cutaways"]],
    ["turn off the captions", ["remove:captions"]],
    ["remove the zooms and transitions", ["remove:zooms", "remove:transitions"]],
    ["remove the black and white", ["remove:look"]],
    ["add captions", ["captions"]],
    ["add a progress bar", ["progress"]],
    ["add some sound effects", ["sfx"]],
    ["add music", ["music"]],
    ["add calm music", ["music"]],
    ["add a title \"3 tips for your first job\" at the start", ["title"]],
    ["add a callout saying Free for students", ["callout"]],
    ["add a name caption \"Obed Apochi, Founder\"", ["lower-third"]],
    ["make the titles green", ["color"]],
    ["add a clip of a city at night behind me", ["stock"]],
    ["add a gif of applause here", ["stock"]],
    ["use my office photo here", ["broll"]],
    ["add a voice-over \"Welcome to the course\"", ["voiceover"]],
    ["blur my background", ["background"]],
    ["make it black and white", ["look"]],
  ];
  for (const [request, expected] of cases) {
    const plan = await ask(request, { playheadS: 12 });
    assert.deepEqual(kinds(plan).filter((k) => k !== "advice"), expected, request + " → " + JSON.stringify(plan.suggestions));
  }
});

test("details come through: text, place, mode and query", async () => {
  const title = (await ask("add a title \"3 tips for your first job\" at the start")).suggestions[0];
  assert.equal(title.text, "3 tips for your first job"); assert.ok(title.atS < 2);
  const name = (await ask("add a name caption \"Obed Apochi, Founder\"")).suggestions[0];
  assert.equal(name.text, "Obed Apochi"); assert.equal(name.subtitle, "Founder");
  const stock = (await ask("add a clip of a city at night behind me", { playheadS: 12 })).suggestions[0];
  assert.equal(stock.query, "city at night"); assert.equal(stock.mode, "behind"); assert.equal(stock.assetKind, "video"); assert.equal(stock.atS, 12);
  const gif = (await ask("add a gif of applause here", { playheadS: 20 })).suggestions[0];
  assert.equal(gif.assetKind, "gif"); assert.equal(gif.atS, 20);
  const missing = await ask("add a title");
  assert.equal(missing.suggestions[0].kind, "advice", "asks for the words");
});

test("removals and colours become edits", async () => {
  const timeline = { durationUs: 24_000_000, tracks: [
    { id: "v", kind: "video", clips: [{ id: "c", assetId: "a", sourceStartUs: 1_000_000, sourceEndUs: 25_000_000, timelineStartUs: 0, timelineEndUs: 24_000_000, transform: { zoom: "punch" } }] },
    { id: "o", kind: "overlay", clips: [{ id: "g1", assetId: "generated:graphic", sourceStartUs: 0, sourceEndUs: 1, timelineStartUs: 0, timelineEndUs: 3_000_000, transform: { role: "graphic", kind: "title", text: "Hi" } }, { id: "progress", assetId: "generated:progress", sourceStartUs: 0, sourceEndUs: 1, timelineStartUs: 0, timelineEndUs: 1, transform: { role: "progress" } }] },
    { id: "m", kind: "audio", clips: [{ id: "sfx-1", assetId: "generated:sfx", sourceStartUs: 0, sourceEndUs: 1, timelineStartUs: 0, timelineEndUs: 1, transform: { role: "sfx", kind: "pop", volumeDb: -18 } }, { id: "music", assetId: "m", sourceStartUs: 0, sourceEndUs: 1, timelineStartUs: 0, timelineEndUs: 1, transform: { role: "music", volumeDb: -16 } }] },
  ] };
  const plan = await ask("remove the sound effects and the zooms");
  const ops = effectOperations(plan, new Set(plan.suggestions.map((s) => s.id)), timeline, "a");
  assert.deepEqual(ops, [{ type: "remove-clip", clipId: "sfx-1", reason: "Sound effects removed" }, { type: "set-clip-effects", clipId: "c", zoom: "none" }]);
  const quieter = await ask("The background volume is higher than the main");
  assert.deepEqual(effectOperations(quieter, new Set(quieter.suggestions.map((s) => s.id)), timeline, "a"), [{ type: "set-volume", clipId: "music", volumeDb: -24 }]);
  const green = await ask("make the titles green");
  assert.deepEqual(effectOperations(green, new Set(["color"]), timeline, "a"), [{ type: "update-graphic", clipId: "g1", color: "#46A758" }, { type: "set-progress-bar", enabled: true, color: "#46A758" }]);
  const captions = await ask("add captions");
  const words = [{ text: "We", startUs: 1_000_000, endUs: 1_200_000 }, { text: "built", startUs: 1_250_000, endUs: 1_500_000 }];
  const capOps = planOperations(captions, new Set(["captions"]), { timeline, assetId: "a", words });
  assert.ok(capOps.some((o) => o.type === "add-caption-cue"));
});
