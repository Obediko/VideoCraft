import test from "node:test";
import assert from "node:assert/strict";
import { RuleBasedIntentAnalyzer } from "../dist/index.js";

test("intent analyzer produces structured, evidenced tailoring profile", async () => {
  const result = await new RuleBasedIntentAnalyzer().analyze({ prompt: "Make a playful 30 second TikTok for new developers" });
  assert.equal(result.profile.channel, "short-form");
  assert.equal(result.profile.audience, "Developers and technical practitioners");
  assert.equal(result.profile.targetDurationUs, 30_000_000);
  assert.equal(result.evidence[0].source, "user");
});
