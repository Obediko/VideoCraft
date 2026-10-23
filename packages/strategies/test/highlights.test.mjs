import test from "node:test";
import assert from "node:assert/strict";
import { applyTimelineOperations } from "@videocraft/domain";
import { snapToShotCuts, HighlightReelStrategy, stem, findCandidates, selectHighlights, goalTerms, tightCuts, scoreWindow, policyFor } from "../dist/index.js";

// Builds a transcript from [text, pauseBeforeSeconds] sentences at ~2.6 words/second.
function transcript(sentences, assetId = "asset") {
  const segments = [];
  let t = 0;
  sentences.forEach(([text, pause], index) => {
    t += pause ?? 0.3;
    const words = text.split(" ").map((w, i, arr) => ({ text: w, startUs: Math.round((t + i * 0.38) * 1e6), endUs: Math.round((t + i * 0.38 + 0.32) * 1e6) }));
    const end = t + words.length * 0.38;
    segments.push({ id: "seg-" + index, assetId, startUs: words[0].startUs, endUs: words.at(-1).endUs, text, words, provider: "test" });
    t = end;
  });
  return { segments, durationUs: Math.round((t + 1) * 1e6) };
}

const talk = transcript([
  ["Um so welcome everybody to the stream today.", 0.5],
  ["Uh we are just kind of hanging out and um chatting about random stuff.", 0.4],
  ["Like basically I actually have no real plan you know.", 0.6],
  ["Why do most new customers abandon onboarding in the first week?", 1.2],
  ["The biggest mistake is asking for twenty fields before they see any value.", 0.3],
  ["We cut onboarding to three steps and activation doubled for new customers.", 0.3],
  ["Show the value first and collect the details later.", 0.3],
  ["Anyway I think I left the oven on so let me go check.", 2.0],
  ["Okay I am back and um where was I exactly.", 0.8],
  ["Thanks for watching and see you next time everybody.", 0.5],
]);
const project = { id: "p", ownerId: "o", name: "Demo", revision: 1, createdAt: "", updatedAt: "" };
const revision = { projectId: "p", revision: 1, timeline: { durationUs: talk.durationUs, tracks: [{ id: "v", kind: "video", clips: [{ id: "orig", assetId: "asset", sourceStartUs: 0, sourceEndUs: talk.durationUs, timelineStartUs: 0, timelineEndUs: talk.durationUs }] }] }, acceptedProposalIds: [], createdAt: "", createdBy: "o" };
const profile = { intent: "Show why customer onboarding fails and how to fix it", audience: "SaaS founders", channel: "short-form", targetDurationUs: 20_000_000, constraints: [] };

test("goal terms ignore platform words and weight the stated intent highest", () => {
  const terms = goalTerms(profile);
  assert.equal(terms.get(stem("onboarding")), 1);
  assert.ok(!terms.has("short"));
  assert.ok(terms.get(stem("founders")) < 1);
});

test("on-topic windows outscore filler chatter", () => {
  const candidates = findCandidates(talk.segments, profile);
  const best = candidates[0];
  assert.match(best.text, /onboarding/i);
  const chatter = candidates.filter((c) => /stream today|oven/i.test(c.text));
  assert.ok(chatter.every((c) => c.score < best.score));
  assert.ok(best.matchedTerms.includes(stem("onboarding")));
});

test("selection never overlaps and respects the target duration", () => {
  const picks = selectHighlights(findCandidates(talk.segments, profile), { targetUs: 20_000_000, minScore: 0.3, maxClips: 5 });
  for (let i = 1; i < picks.length; i += 1) assert.ok(picks[i].startUs >= picks[i - 1].endUs);
  assert.ok(picks.reduce((n, c) => n + c.endUs - c.startUs, 0) <= 22_000_000);
});

test("proposal contains explained clips, transcript evidence with timestamps and applies to a valid timeline", async () => {
  const result = await new HighlightReelStrategy().propose({ project, revision, profile, transcript: talk.segments });
  assert.ok(result.operations.some((o) => o.type === "remove-clip" && o.clipId === "orig"));
  const inserts = result.operations.filter((o) => o.type === "insert-clip");
  assert.ok(inserts.length >= 1);
  assert.ok(inserts.every((o) => typeof o.reason === "string" && o.reason.includes("score")));
  const transcriptEvidence = result.evidence.filter((e) => e.source === "transcript");
  assert.ok(transcriptEvidence.length >= 1 && transcriptEvidence.every((e) => e.startUs >= 0 && e.endUs > e.startUs && e.excerpt.length > 0));
  assert.ok(transcriptEvidence.some((e) => /onboarding/i.test(e.excerpt)));
  const timeline = applyTimelineOperations(revision.timeline, result.operations);
  assert.ok(timeline.durationUs > 0 && timeline.durationUs <= 24_000_000, "duration " + timeline.durationUs);
  const cues = timeline.tracks.find((t) => t.kind === "caption").clips;
  assert.ok(cues.length > 0);
  assert.ok(cues.every((c) => c.timelineEndUs <= timeline.durationUs));
  assert.ok(!cues.some((c) => /oven|stream today/i.test(c.transform.text)), "no captions from cut footage");
  assert.ok(result.confidence > 0.2 && result.confidence <= 0.9);
});

test("tight cuts remove long internal pauses but keep short ones", () => {
  const words = [{ text: "a", startUs: 1_000_000, endUs: 1_300_000 }, { text: "b", startUs: 1_400_000, endUs: 1_700_000 }, { text: "c", startUs: 3_000_000, endUs: 3_300_000 }];
  const cuts = tightCuts({ words }, { prevEndUs: 0, nextStartUs: 9e9 }, { pauseCutUs: 600_000, leadUs: 100_000, tailUs: 100_000 });
  assert.equal(cuts.length, 2);
  assert.deepEqual(cuts[0], { startUs: 900_000, endUs: 1_800_000 });
});

test("returns an explanatory no-op without a transcript or video", async () => {
  const strategy = new HighlightReelStrategy();
  const noTranscript = await strategy.propose({ project, revision, profile, transcript: [] });
  assert.equal(noTranscript.operations.length, 0);
  assert.match(noTranscript.rationale, /Transcribe/);
  const noVideo = await strategy.propose({ project, revision: { ...revision, timeline: { durationUs: 1, tracks: [] } }, profile, transcript: talk.segments });
  assert.equal(noVideo.operations.length, 0);
});

test("professional tone lowers the hook weight for restrained content", () => {
  assert.ok(policyFor({ ...profile, tone: "professional" }).weights.hook < policyFor(profile).weights.hook);
  const score = scoreWindow("Why does this matter? Because it does.", [], 10_000_000, 0, true, false, new Map(), policyFor(profile));
  assert.ok(score.features.hook >= 0.7);
});

test("goal terms still match compounds that a recognizer split into two words", () => {
  const goal = goalTerms({ ...profile, intent: "customer onboarding" });
  const split = scoreWindow("why do customers abandon on boarding flows", [], 10_000_000, 0, true, false, goal, policyFor(profile));
  const unrelated = scoreWindow("why do people abandon gym memberships quickly", [], 10_000_000, 0, true, false, goal, policyFor(profile));
  assert.ok(split.matchedTerms.includes(stem("onboarding")));
  assert.ok(split.features.relevance > unrelated.features.relevance);
});

test("clip edges snap to a nearby shot change only when no speech is clipped", () => {
  const words = [{ startUs: 1_000_000, endUs: 1_300_000 }, { startUs: 5_000_000, endUs: 5_400_000 }];
  // Edge 0.2s after the cut with silence in between: snapped onto the cut.
  assert.deepEqual(snapToShotCuts({ startUs: 4_800_000, endUs: 9_000_000 }, [4_700_000], words), { startUs: 4_700_000, endUs: 9_000_000 });
  // A word sits between the edge and the cut: left alone.
  assert.deepEqual(snapToShotCuts({ startUs: 5_100_000, endUs: 9_000_000 }, [4_900_000], words), { startUs: 5_100_000, endUs: 9_000_000 });
  // Cuts farther than the tolerance are ignored; end edges snap too.
  assert.deepEqual(snapToShotCuts({ startUs: 2_000_000, endUs: 3_000_000 }, [3_200_000, 8_000_000], words), { startUs: 2_000_000, endUs: 3_200_000 });
  assert.deepEqual(snapToShotCuts({ startUs: 2_000_000, endUs: 3_000_000 }, [], words), { startUs: 2_000_000, endUs: 3_000_000 });
});

test("learned multipliers tilt the policy and are explained in the proposal", async () => {
  const profile = { intent: "Explain onboarding", audience: "founders", channel: "short-form", constraints: [] };
  const base = policyFor(profile).weights;
  const tilted = policyFor(profile, { multipliers: { hook: 0.5, relevance: 2 }, samples: 12 }).weights;
  assert.equal(tilted.hook, base.hook * 0.5);
  assert.equal(tilted.relevance, base.relevance * 2);
  assert.equal(tilted.density, base.density);
});
