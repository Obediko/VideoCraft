import test from "node:test";
import assert from "node:assert/strict";
import { artificialPhrases } from "../dist/craft.js";
import { storyboardPlanner } from "../dist/creation.js";

test("machine-sounding phrases are caught; plain writing passes", () => {
  assert.deepEqual(artificialPhrases("Embark on a transformative journey that empowers communities. It's not just help, it's hope."), ["journey", "empower", "transformative", "embark", "it's not just X, it's Y"]);
  assert.deepEqual(artificialPhrases("Ada got stuck on long division. Her neighbour sat down and showed her twice. Now she shows her brother."), []);
});

test("the storyboard writer gets the craft notes, explores three approaches, and passes a final draft through the critic", async () => {
  const sent = []; const real = globalThis.fetch;
  const scene = { assetId: "", startS: 0, durationS: 12, text: "", visual: "A girl does homework at a table.", search: "girl homework table" };
  const approaches = { approaches: [
    { label: "Direct", strategy: "factual", summary: "s", script: "Ada is stuck on long division. Her neighbour pulls up a chair and works through one example with her.", scenes: [scene] },
    { label: "Human", strategy: "story", summary: "s", script: "The pencil stops. A neighbour notices, sits beside Ada, and helps her find the next step.", scenes: [scene] },
    { label: "Question", strategy: "question", summary: "s", script: "What changes when help lives next door? Ada gets an answer, then shows the same method to her brother.", scenes: [scene] },
  ] };
  const final = { summary: "s", script: "Ada pauses over long division. Her neighbour sits beside her and explains one example. Later, Ada uses the same steps to help her younger brother finish his homework.", scenes: [scene], selectedApproach: "Human", critique: "Specific, grounded, and natural." };
  globalThis.fetch = async (_url, init) => { const body = JSON.parse(init.body); sent.push(body); return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(sent.length === 1 ? approaches : final) }) }; };
  try {
    const plan = await storyboardPlanner({ apiKey: "k", model: "m" })({ brief: "Neighbours helping", seconds: 20, assets: [], frames: [] });
    assert.match(sent[0].instructions, /Show, do not tell/);
    assert.match(sent[0].instructions, /Never use these words/);
    assert.equal(sent.length, 2, "writer and critic each run once");
    assert.match(sent[1].instructions, /severe script editor/i);
    assert.equal(JSON.parse(sent[1].input[0].content[0].text).approaches.length, 3);
    assert.equal(plan.script, final.script);
  } finally { globalThis.fetch = real; }
});
