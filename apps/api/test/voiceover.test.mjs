import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { registerVoiceoverRoutes } from "../dist/voiceover.js";

test("typed voice-over: sent to the speech API with the chosen voice and stored as an audio asset", async () => {
  const root = mkdtempSync(join(tmpdir(), "vc-voice-"));
  const saved = []; let sent;
  const server = Fastify();
  registerVoiceoverRoutes(server, {
    apiKey: "sk-test", fetch: async (url, init) => { sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization }; return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, text: async () => "" }; },
    assets: { listForProject: async () => saved, save: async (a) => { saved.push(a); } },
    storage: { resolve: (k) => join(root, k), putFile: async (from, key) => { mkdirSync(dirname(join(root, key)), { recursive: true }); copyFileSync(from, join(root, key)); return { key, checksumSha256: "x" }; }, remove: async () => {} },
    inspector: async () => ({ durationUs: 2_400_000, formatName: "mp3", sizeBytes: 3, hasVideo: false, hasAudio: true }),
    authenticate: async (req) => (req.headers.authorization === "Bearer ok" ? { userId: "u" } : null),
    authorize: { canAccess: async (_p, projectId) => projectId === "p1" },
    clock: () => "2026-10-29T00:00:00Z",
  });
  try {
    const headers = { authorization: "Bearer ok" };
    assert.equal((await server.inject({ method: "POST", url: "/v1/projects/p2/voiceover/speech", headers, payload: { text: "hi" } })).statusCode, 403);
    assert.equal((await server.inject({ method: "POST", url: "/v1/projects/p1/voiceover/speech", headers, payload: { text: "" } })).statusCode, 400);
    const made = await server.inject({ method: "POST", url: "/v1/projects/p1/voiceover/speech", headers, payload: { text: "Welcome to the course.", voice: "nova", style: "warm and calm" } });
    assert.equal(made.statusCode, 201, made.body);
    assert.equal(sent.body.voice, "nova"); assert.equal(sent.body.input, "Welcome to the course."); assert.equal(sent.body.instructions, "warm and calm");
    assert.equal(sent.auth, "Bearer sk-test");
    const asset = made.json().asset;
    assert.equal(asset.kind, "audio"); assert.equal(asset.durationUs, 2_400_000); assert.equal(asset.metadata.voiceover, true);
    assert.ok(!made.body.includes("sk-test"));
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});
