import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerIntentRoutes } from "../dist/intent-routes.js";

function setup() {
  const seen = [];
  let transcriptReads = 0;
  const server = Fastify();
  registerIntentRoutes(server, {
    analyzer: {
      async analyze(input) {
        seen.push(input);
        return { profile: { intent: input.prompt, audience: "test", channel: "web", constraints: [] }, evidence: [], provider: "test", providerVersion: "1" };
      }
    },
    authenticate: async () => ({ userId: "user-1" }),
    authorize: { canAccess: async () => true },
    assets: { listForProject: async () => [{ id: "asset-1" }] },
    transcripts: {
      async listForAsset() {
        transcriptReads += 1;
        return [{ id: "segment-1", assetId: "asset-1", startUs: 0, endUs: 1_000_000, text: "private speech", words: [], provider: "test" }];
      }
    }
  });
  return { server, seen, getTranscriptReads: () => transcriptReads };
}

test("intent analysis excludes project transcript by default", async () => {
  const { server, seen, getTranscriptReads } = setup();
  const response = await server.inject({ method: "POST", url: "/v1/projects/project-1/intent/analyze", payload: { prompt: "Summarize this" } });
  assert.equal(response.statusCode, 200);
  assert.equal(seen[0].transcript.length, 0);
  assert.equal(getTranscriptReads(), 0);
  await server.close();
});

test("intent analysis includes persisted transcript only with explicit consent", async () => {
  const { server, seen, getTranscriptReads } = setup();
  const response = await server.inject({ method: "POST", url: "/v1/projects/project-1/intent/analyze", payload: { prompt: "Summarize this", includeTranscript: true } });
  assert.equal(response.statusCode, 200);
  assert.equal(seen[0].transcript[0].text, "private speech");
  assert.equal(getTranscriptReads(), 1);
  await server.close();
});
