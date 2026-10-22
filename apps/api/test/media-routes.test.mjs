import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerMediaRoutes } from "../dist/media-routes.js";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "vc-media-"));
  mkdirSync(join(root, "projects/p1/uploads"), { recursive: true });
  const bytes = Buffer.from("0123456789abcdefghij");
  writeFileSync(join(root, "projects/p1/uploads/a.mp4"), bytes);
  const server = Fastify();
  registerMediaRoutes(server, {
    assets: { listForProject: async (id) => id === "p1" ? [{ id: "a1", storageKey: "projects/p1/uploads/a.mp4", kind: "video", metadata: {} }, { id: "evil", storageKey: "projects/other/uploads/x.mp4", kind: "video", metadata: {} }] : [] },
    storage: { resolve: (key) => join(root, key) },
    signingSecret: "s3cret-s3cret-s3cret",
    authenticate: async (req) => req.headers.authorization === "Bearer ok" ? { userId: "u" } : null,
    authorize: { canAccess: async (_p, projectId) => projectId === "p1" },
  });
  return { server, root, close: async () => { await server.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("playback url is authenticated, project-scoped, signed, and the media supports byte ranges", async () => {
  const { server, close } = await setup();
  try {
    assert.equal((await server.inject({ url: "/v1/projects/p1/assets/a1/playback-url" })).statusCode, 401);
    assert.equal((await server.inject({ url: "/v1/projects/p2/assets/a1/playback-url", headers: { authorization: "Bearer ok" } })).statusCode, 403);
    assert.equal((await server.inject({ url: "/v1/projects/p1/assets/evil/playback-url", headers: { authorization: "Bearer ok" } })).statusCode, 404, "asset keyed outside the project is not served");
    const issued = await server.inject({ url: "/v1/projects/p1/assets/a1/playback-url", headers: { authorization: "Bearer ok" } });
    assert.equal(issued.statusCode, 200);
    const url = issued.json().url;

    const full = await server.inject({ url });
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers["content-type"], "video/mp4");
    assert.equal(full.headers["accept-ranges"], "bytes");
    assert.equal(full.body, "0123456789abcdefghij");

    const part = await server.inject({ url, headers: { range: "bytes=5-9" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers["content-range"], "bytes 5-9/20");
    assert.equal(part.body, "56789");
    const tail = await server.inject({ url, headers: { range: "bytes=-4" } });
    assert.equal(tail.body, "ghij");
    const open = await server.inject({ url, headers: { range: "bytes=15-" } });
    assert.equal(open.body, "fghij");
    assert.equal((await server.inject({ url, headers: { range: "bytes=50-60" } })).statusCode, 416);

    assert.equal((await server.inject({ url: url.replace(/signature=.{4}/, "signature=AAAA") })).statusCode, 401);
    assert.equal((await server.inject({ url: "/v1/projects/p1/assets/a1/media" })).statusCode, 401);
    assert.equal((await server.inject({ url: url.replace(/expires=\d+/, "expires=1") })).statusCode, 401);
  } finally { await close(); }
});
