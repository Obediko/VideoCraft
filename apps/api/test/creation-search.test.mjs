import test from "node:test";
import assert from "node:assert/strict";
import { stockQuery, storyScenes } from "../dist/creation.js";

test("storyboard scenes carry short stock search words", () => {
  assert.equal(stockQuery("Opening vignette, Nigerian residential courtyard in soft morning light. Close-up of a school-age girl's pencil pausing over an exercise book."), "nigerian courtyard girl pencil exercise");
  assert.equal(stockQuery("Cut to a quiet, sunlit Nigerian neighborhood lane with people moving naturally through the background."), "nigerian neighborhood lane people");
  const [given, worked] = storyScenes([
    { assetId: "", startS: 0, durationS: 4, text: "", visual: "A tailor shows an apprentice how to fold cloth", search: "tailor teaching apprentice" },
    { assetId: "", startS: 0, durationS: 4, text: "", visual: "Wide shot of students studying in a library" },
  ], [], true);
  assert.equal(given.search, "tailor teaching apprentice", "the AI's words are kept");
  assert.equal(worked.search, "students studying library", "older plans get words from the description");
});
