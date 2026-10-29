import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiDirector } from "../dist/index.js";

const input = {
  brief: "Reel for graduates", durationS: 60, frame: { width: 1080, height: 1920 },
  transcript: [{ startS: 1, endS: 8, text: "We built a mentoring programme." }, { startS: 9, endS: 16, text: "Pricing starts at ten euros." }, { startS: 17, endS: 25, text: "Half of them found jobs." }],
  candidates: [], frames: [], assets: [],
  instruction: "remove the part about pricing",
  current: { pieces: [{ startS: 1, endS: 25, text: "We built … pricing … jobs." }], graphics: ["title: Mentoring"], look: "warm", music: "yes", seconds: 24 },
};

test("ask (OpenAI): the current edit and the request are sent; the answer becomes a reviewable plan", async () => {
  let sent;
  const fetchImpl = async (_url, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ summary: "Pricing removed.", profile: { intent: "x", audience: "", channel: "short-form", tone: "", targetSeconds: 16 }, suggestions: [{ id: "cut", kind: "cut", title: "Drop the pricing line", reason: "You asked.", segments: [{ startS: 1, endS: 8 }, { startS: 17, endS: 25 }], text: "", subtitle: "", atS: 0, durationS: 0, position: "", mood: "", assetId: "", mode: "", platform: "", look: "", style: "", transition: "" }] }) }), text: async () => "" }; };
  const plan = await new OpenAiDirector({ apiKey: "k", model: "m", fetchImpl }).ask(input);
  const text = sent.input[0].content[0].text;
  assert.match(text, /The creator asks for this change: remove the part about pricing/);
  assert.match(text, /\[1\.0-25\.0\] We built/);
  assert.match(sent.instructions, /changing an existing edit/);
  assert.equal(plan.source, "ai");
  assert.deepEqual(plan.suggestions[0].segments, [{ startS: 1, endS: 8 }, { startS: 17, endS: 25 }]);
});

test("ask (OpenAI) falls back to the rules, which say plainly what they cannot do", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" });
  const plan = await new OpenAiDirector({ apiKey: "k", model: "m", fetchImpl }).ask(input);
  assert.equal(plan.source, "rules");
  assert.match(plan.note, /unavailable/);
  assert.equal(plan.suggestions[0].kind, "advice");
});
