import test from "node:test";
import assert from "node:assert/strict";
import { criticInstructions, scriptKind, scriptPreferences, scriptQualityIssues, writerInstructions } from "../dist/director-playbook.js";

test("the playbook selects useful structures and bounds creator preferences", () => {
  assert.equal(scriptKind("A customer testimonial about her experience"), "testimonial");
  assert.equal(scriptKind("Explain how composting works"), "educational");
  assert.equal(scriptKind("A church sermon about hope"), "sermon");
  const p = scriptPreferences({ notes: "Understated Nigerian English", preferredSentenceWords: 9, avoidPhrases: ["at the end of the day"] });
  assert.equal(p.preferredSentenceWords, 9);
  assert.match(writerInstructions("A community programme story", p), /THREE genuinely different approaches/);
  assert.match(writerInstructions("A community programme story", p), /human need/);
  assert.match(criticInstructions(p), /factual grounding/);
});

test("the deterministic quality gate rejects generic AI copy", () => {
  const p = scriptPreferences({ avoidPhrases: ["dream big"] });
  assert.deepEqual(scriptQualityIssues("In today's fast-paced world, dream big.", "A 30 second story", p).slice(0, 1), ["generic phrase: in today's fast-paced world"]);
  const grounded = "Ada opens the workshop at eight. Three apprentices arrange their tools. She demonstrates one stitch, watches them repeat it, and corrects the loose thread. By noon, each person has finished a usable sample. Visit Saturday to see the class and ask about the next intake.";
  assert.deepEqual(scriptQualityIssues(grounded, "A 20 second organisation story", scriptPreferences(null)), []);
});

test("twenty representative briefs route to the intended writing structure", () => {
  const cases = [
    ["Customer testimonial about her first month", "testimonial"], ["A client describes his experience", "testimonial"],
    ["Explain how insulin works", "educational"], ["Tutorial: how to prepare plantain", "educational"],
    ["Teach new volunteers the safeguarding steps", "educational"], ["Launch our bookkeeping product", "product"],
    ["Demonstrate a service for small shops", "product"], ["Sell the new appointment tool", "product"],
    ["Church sermon about forgiveness", "sermon"], ["Bible devotion on hope", "sermon"],
    ["Faith message for a youth gathering", "sermon"], ["Our nonprofit mentoring programme", "organisation"],
    ["A community charity serving families", "organisation"], ["Show what our organisation changed", "organisation"],
    ["Introduce the ministry's work", "organisation"], ["A woman returns to her childhood home", "story"],
    ["A quiet portrait of a new father", "story"], ["A wedding anniversary memory", "story"],
    ["A short film about missing the last bus", "story"], ["Tell the story of an old photograph", "story"],
  ];
  assert.equal(cases.length, 20);
  for (const [brief, expected] of cases) assert.equal(scriptKind(brief), expected, brief);
});
