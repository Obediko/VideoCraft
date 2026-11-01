import test from "node:test";
import assert from "node:assert/strict";
import { artificialPhrases } from "../dist/craft.js";
import { storyboardPlanner } from "../dist/creation.js";

test("machine-sounding phrases are caught; plain writing passes", () => {
  assert.deepEqual(artificialPhrases("Embark on a transformative journey that empowers communities. It's not just help, it's hope."), ["journey", "empower", "transformative", "embark", "it's not just X, it's Y"]);
  assert.deepEqual(artificialPhrases("Ada got stuck on long division. Her neighbour sat down and showed her twice. Now she shows her brother."), []);
});

test("the storyboard writer gets the craft notes and rewrites a machine-sounding draft once", async () => {
  const sent = []; const real = globalThis.fetch;
  const reply = (script) => ({ ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ summary: "s", script, scenes: [{ assetId: "", startS: 0, durationS: 4, text: "", visual: "A girl does homework at a table.", search: "girl homework table" }] }) }) });
  globalThis.fetch = async (_url, init) => { const body = JSON.parse(init.body); sent.push(body); return reply(sent.length === 1 ? "Join us on a transformative journey to empower every child." : "Ada was stuck on her homework. A neighbour sat down and helped."); };
  try {
    const plan = await storyboardPlanner({ apiKey: "k", model: "m" })({ brief: "Neighbours helping", seconds: 20, assets: [], frames: [] });
    assert.match(sent[0].instructions, /Show, do not tell/);
    assert.match(sent[0].instructions, /Never use these words/);
    assert.equal(sent.length, 2, "one rewrite");
    assert.match(sent[1].input.at(-1).content[0].text, /transformative, journey|journey, empower|empower/);
    assert.equal(plan.script, "Ada was stuck on her homework. A neighbour sat down and helped.");
  } finally { globalThis.fetch = real; }
});
