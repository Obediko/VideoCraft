import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRenderRoutes } from "../dist/render-routes.js";

test("render status and short-lived download URL are project-scoped", async () => {
  const app = Fastify();
  const jobs = new Map([["render-1", { id: "render-1", projectId: "project-1", revision: 1, settings: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 }, idempotencyKey: "idem-12345678", status: "succeeded", progress: 100, output: { storageKey: "renders/render-1.mp4", checksumSha256: "a".repeat(64), sizeBytes: 10, mimeType: "video/mp4" } }]]);
  registerRenderRoutes(app, {
    jobs: { get: async (id) => jobs.get(id), save: async () => undefined, update: async () => undefined },
    storage: { resolve: () => "unused", putFile: async () => { throw new Error("unused"); }, remove: async () => undefined },
    signingSecret: "s".repeat(32),
    authenticate: async () => ({ userId: "user-1" }),
    authorize: { canAccess: async () => true },
  });
  const response = await app.inject({ method: "GET", url: "/v1/projects/project-1/renders/render-1/download-url" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.match(body.url, /signature=/);
  assert.equal(body.expires > Math.floor(Date.now() / 1000), true);
  await app.close();
});
