import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleIntentAnalyzer, RuleBasedIntentAnalyzer } from "../dist/index.js";

test("intent analyzer produces structured, evidenced tailoring profile", async () => {
  const result = await new RuleBasedIntentAnalyzer().analyze({ prompt: "Make a playful 30 second TikTok for new developers" });
  assert.equal(result.profile.channel, "short-form");
  assert.equal(result.profile.audience, "Developers and technical practitioners");
  assert.equal(result.profile.targetDurationUs, 30_000_000);
  assert.equal(result.evidence[0].source, "user");
});

test("OpenAI-compatible adapter validates structured provider output", async () => {
  let request;
  const analyzer = new OpenAiCompatibleIntentAnalyzer({
    endpoint: "https://provider.example/v1/",
    apiKey: "secret",
    model: "intent-model",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ profile: { intent: "Explain it", audience: "Developers", channel: "short-form", tone: "clear", constraints: [] }, evidence: [{ source: "model", reference: "provider.output", excerpt: "structured" }] }) } }] }; } };
    },
  });
  const result = await analyzer.analyze({ prompt: "Explain it to developers" });
  assert.equal(request.url, "https://provider.example/v1/chat/completions");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.equal(result.profile.audience, "Developers");
  assert.equal(result.provider, "openai-compatible");
});


test("OpenAI-compatible adapter fails with a bounded timeout", async () => {
  const analyzer = new OpenAiCompatibleIntentAnalyzer({
    endpoint: "https://provider.example/v1",
    apiKey: "secret",
    model: "intent-model",
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) => await new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  });
  await assert.rejects(() => analyzer.analyze({ prompt: "Explain it" }), /timed out/);
});
