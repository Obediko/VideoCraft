import test from "node:test";
import assert from "node:assert/strict";
import { buildCues, cueOperations, wordDurationsCs, renderAss, CAPTION_STYLES, assTime, escapeAss } from "../dist/index.js";

const w = (text, s, e) => ({ text, startUs: s * 1e6, endUs: e * 1e6 });
const words = [w("Welcome", 0, .4), w("to", .45, .55), w("the", .6, .7), w("show.", .75, 1.2), w("Today", 2.5, 2.9), w("we", 2.95, 3.05), w("talk", 3.1, 3.4), w("about", 3.45, 3.8), w("{braces}", 3.85, 4.2)];

test("cues break on sentence ends, pauses and word limits", () => {
  const cues = buildCues(words);
  assert.deepEqual(cues.map((c) => c.text), ["Welcome to the show.", "Today we talk about", "{braces}"]);
  assert.equal(cues[0].startUs, 0);
});

test("ranges exclude words from removed footage", () => {
  const cues = buildCues(words, { ranges: [{ startUs: 2_400_000, endUs: 4_300_000 }] });
  assert.equal(cues[0].text, "Today we talk about");
  assert.equal(cues.some((c) => c.text.includes("Welcome")), false);
});

test("word durations exactly cover the cue", () => {
  const cue = buildCues(words)[0];
  const durations = wordDurationsCs(cue);
  assert.equal(durations.reduce((a, b) => a + b, 0), Math.round((cue.endUs - cue.startUs) / 1e4));
  const ops = cueOperations("asset", [cue]);
  assert.equal(ops[0].type, "add-caption-cue");
  assert.equal(ops[0].wordDurationsCs.length, 4);
});

test("ASS output highlights each active word and escapes override characters", () => {
  const ass = renderAss([{ startUs: 1_000_000, endUs: 2_000_000, text: "go {now} please", wordDurationsCs: [30, 40, 30] }], CAPTION_STYLES["bold-pop"], { width: 1080, height: 1920 });
  assert.match(ass, /PlayResX: 1080/);
  const dialogue = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(dialogue.length, 3);
  assert.match(dialogue[0], /0:00:01\.00,0:00:01\.30/);
  assert.match(dialogue[1], /\{\\c&H00D7FF&[^}]*\}\(NOW\)/);
  assert.equal(escapeAss("a{b}\\c"), "a(b)\\\\c");
  assert.equal(assTime(3_661_230_000), "1:01:01.23");
});

test("static captions for cues without word timings", () => {
  const ass = renderAss([{ startUs: 0, endUs: 1_000_000, text: "Hello world" }], CAPTION_STYLES.clean, { width: 1280, height: 720 });
  assert.equal(ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length, 1);
});
