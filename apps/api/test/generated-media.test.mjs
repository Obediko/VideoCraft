import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAssetRepository } from "@videocraft/application";
import { LocalObjectStorage } from "@videocraft/storage";
import { isStillImage } from "@videocraft/analysis";
import { registerGeneratedMediaRoutes } from "../dist/generated-media.js";

test("generated image capability is explicit; approved provider bytes become the stored, decodable project asset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vc-generated-")); const server = Fastify();
  const assets = new InMemoryAssetRepository(), storage = new LocalObjectStorage(directory);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  let request, fail = false;
  registerGeneratedMediaRoutes(server, { apiKey: "test", imageModel: "configured-model", assets, storage, clock: () => "", authenticate: async () => ({ userId: "u" }), authorize: { canAccess: async (_, id) => id === "p" }, imageInspector: isStillImage,
    fetch: async (_, init) => { request = JSON.parse(init.body); return fail ? new Response("unavailable", { status: 503 }) : Response.json({ data: [{ b64_json: png.toString("base64") }] }); },
  });
  try {
    assert.equal((await server.inject("/v1/projects/p/creation/capabilities")).json().images, true);
    const response = await server.inject({ method: "POST", url: "/v1/projects/p/creation/image", payload: { prompt: "A hopeful sunrise" } });
    assert.equal(response.statusCode, 201, response.body);
    const { asset } = response.json(); assert.equal(asset.kind, "image"); assert.equal(asset.metadata.generated, true);
    assert.equal(request.model, "configured-model"); assert.equal(request.n, 1); assert.equal(request.output_format, "png");
    assert.deepEqual(readFileSync(storage.resolve(asset.storageKey)), png);
    assert.equal((await assets.listForProject("p")).length, 1);
    assert.equal((await server.inject({ method: "POST", url: "/v1/projects/foreign/creation/image", payload: { prompt: "A sunrise" } })).statusCode, 403);
    fail = true;
    const failed = await server.inject({ method: "POST", url: "/v1/projects/p/creation/image", payload: { prompt: "Another sunrise" } });
    assert.equal(failed.statusCode, 502); assert.match(failed.json().error.message, /503/); assert.equal((await assets.listForProject("p")).length, 1);
  } finally { await server.close(); rmSync(directory, { force: true, recursive: true }); }
});

test("missing image configuration never advertises a working generation button", async () => {
  const server = Fastify();
  registerGeneratedMediaRoutes(server, { assets: {}, storage: {}, clock: () => "", authenticate: async () => ({ userId: "u" }), authorize: { canAccess: async () => true }, imageInspector: isStillImage });
  try {
    assert.deepEqual((await server.inject("/v1/projects/p/creation/capabilities")).json(), { images: false, generatedVideo: false });
    assert.equal((await server.inject({ method: "POST", url: "/v1/projects/p/creation/image", payload: { prompt: "Sunrise" } })).statusCode, 503);
  } finally { await server.close(); }
});
