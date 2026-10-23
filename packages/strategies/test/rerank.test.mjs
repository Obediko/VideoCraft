import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { applyTimelineOperations } from "@videocraft/domain";
import { HighlightReelStrategy, OpenAiCompatibleReranker, parseScores } from "../dist/index.js";

function transcript(sentences) {
  const segments = [];
  let t = 0;
  sentences.forEach((text, index) => {
    t += 1.2;
    const words = text.split(" ").map((w, i) => ({ text: w, startUs: Math.round((t + i * 0.38) * 1e6), endUs: Math.round((t + i * 0.38 + 0.32) * 1e6) }));
    t = words.at(-1).endUs / 1e6;
    segments.push({ id: "s" + index, assetId: "asset", startUs: words[0].startUs, endUs: words.at(-1).endUs, text, words, provider: "test" });
  });
  return segments;
}
const segments = transcript([
  "Why do new users abandon a product during onboarding so quickly?",
  "The biggest mistake is asking for twenty form fields before they see any value at all.",
  "Honestly my cat walked across the keyboard this morning which was very funny to watch.",
  "Give new users a template or sample data so they see the product working within a minute.",
  "When we cut our onboarding flow down to three simple steps activation doubled in a single month.",
  "Thanks so much for watching and do not forget to subscribe to the channel everybody.",
]);
const duration = segments.at(-1).endUs + 1_000_000;
const revision = { projectId: "p", revision: 1, acceptedProposalIds: [], createdAt: "", createdBy: "u", timeline: { durationUs: duration, tracks: [{ id: "v", kind: "video", clips: [{ id: "src", assetId: "asset", sourceStartUs: 0, sourceEndUs: duration, timelineStartUs: 0, timelineEndUs: duration }] }] } };
const profile = { intent: "Explain why onboarding fails and how to fix it", audience: "SaaS founders", channel: "short-form", targetDurationUs: 9_000_000, constraints: [] };
const run = (strategy) => strategy.propose({ project: { id: "p" }, revision, profile, transcript: segments });
const picked = (proposal) => proposal.operations.filter((o) => o.type === "insert-clip");
const textOf = (op) => segments.flatMap((s) => s.words).filter((w) => w.startUs >= op.sourceStartUs - 200_000 && w.endUs <= op.sourceEndUs + 200_000).map((w) => w.text).join(" ");

test("an AI judge changes which clips are chosen, and its reasons are shown", async () => {
  const judge = { async rerank({ candidates }) { return { model: "judge-1", scores: candidates.map((c) => ({ id: c.id, relevance: /abandon/.test(c.text) ? 1 : 0, reason: /abandon/.test(c.text) ? "Concrete fix founders can apply today." : "Less useful." })) }; } };
  const judged = await run(new HighlightReelStrategy({ reranker: judge, blend: 0.9 }));
  const baseline = await run(new HighlightReelStrategy());
  // A highlight may be several clips once pauses are cut; they share one reason.
  const best = (proposal) => { const top = [...picked(proposal)].sort((x, y) => y.score - x.score)[0]; return { ...top, text: picked(proposal).filter((op) => op.reason === top.reason).map(textOf).join(" ") }; };
  const first = best(judged);
  // The judge loved the window made of the first two sentences; the top pick must come from inside it.
  const inFavoured = (op) => op.sourceStartUs >= segments[0].startUs - 400_000 && op.sourceEndUs <= segments[1].endUs + 400_000;
  assert.ok(inFavoured(first), "the judged favourite is the top pick: " + first.text);
  assert.ok(!inFavoured(best(baseline)), "without the judge another highlight led: " + best(baseline).text);
  assert.ok(picked(judged).every((op) => !/cat walked/.test(textOf(op))), "the tangent stays out");
  assert.match(first.reason, /AI judge: Concrete fix founders can apply today\./);
  assert.ok(judged.evidence.some((e) => e.reference === "llm-rerank:judge-1" && /90% of each score/.test(e.excerpt)));
  assert.ok(applyTimelineOperations(revision.timeline, judged.operations).tracks.length > 0, "proposal still applies");
});

test("a failing judge never blocks a proposal: heuristic scores are used and the fallback is disclosed", async () => {
  const baseline = await run(new HighlightReelStrategy());
  const failing = await run(new HighlightReelStrategy({ reranker: { async rerank() { throw new Error("provider down"); } } }));
  assert.deepEqual(picked(failing).map((o) => [o.sourceStartUs, o.sourceEndUs]), picked(baseline).map((o) => [o.sourceStartUs, o.sourceEndUs]));
  assert.ok(failing.evidence.some((e) => e.reference === "llm-rerank" && /unavailable \(provider down\)/.test(e.excerpt)));
  assert.equal(baseline.evidence.some((e) => e.reference.startsWith("llm-rerank")), false, "no judge, no judge evidence");
});

test("provider answers are validated", () => {
  const wrap = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });
  assert.deepEqual(parseScores(wrap({ scores: [{ id: "c0", relevance: 0.7, reason: " ok  " }, { id: "c1", relevance: 0.2, reason: "meh" }] }), ["c0", "c1"]), [{ id: "c0", relevance: 0.7, reason: "ok" }, { id: "c1", relevance: 0.2, reason: "meh" }]);
  assert.throws(() => parseScores(wrap({ scores: [{ id: "c0", relevance: 0.7 }] }), ["c0", "c1", "c2"]), /only 1 of 3/);
  assert.throws(() => parseScores(wrap({ scores: [{ id: "c0", relevance: 7 }, { id: "zz", relevance: 0.5 }] }), ["c0"]), /only 0 of 1/);
  assert.throws(() => parseScores({ choices: [{ message: { content: "not json" } }] }, ["c0"]), /invalid JSON/);
});

test("OpenAI-compatible adapter: real HTTP round trip, timeout and per-minute budget", async () => {
  let lastBody;
  let delayMs = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      lastBody = JSON.parse(body);
      assert.equal(req.headers.authorization, "Bearer key-123");
      assert.equal(req.url, "/v1/chat/completions");
      const ids = JSON.parse(lastBody.messages[1].content).candidates.map((c) => c.id);
      setTimeout(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scores: ids.map((id, i) => ({ id, relevance: i === 0 ? 0.9 : 0.1, reason: "r" + i })) }) } }] })); }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = "http://127.0.0.1:" + server.address().port + "/v1";
  try {
    const reranker = new OpenAiCompatibleReranker({ endpoint, apiKey: "key-123", model: "m-1", timeoutMs: 1_000, maxPerMinute: 2 });
    const result = await reranker.rerank({ profile, candidates: [{ id: "c0", text: "a", startUs: 0, endUs: 1_000_000 }, { id: "c1", text: "b", startUs: 0, endUs: 2_000_000 }] });
    assert.deepEqual(result.scores.map((s) => [s.id, s.relevance]), [["c0", 0.9], ["c1", 0.1]]);
    assert.equal(lastBody.model, "m-1");
    assert.deepEqual(lastBody.response_format, { type: "json_object" });
    assert.equal(JSON.parse(lastBody.messages[1].content).goal, profile.intent);
    delayMs = 1_500;
    await assert.rejects(reranker.rerank({ profile, candidates: [{ id: "c0", text: "a", startUs: 0, endUs: 1 }] }), /timed out/);
    await assert.rejects(reranker.rerank({ profile, candidates: [{ id: "c0", text: "a", startUs: 0, endUs: 1 }] }), /budget/);
  } finally { server.closeAllConnections?.(); server.close(); }
});
