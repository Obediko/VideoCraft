import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { allowedMediaUrl, registerStockRoutes } from "../dist/stock.js";
import { registerMediaRoutes } from "../dist/media-routes.js";
import { LocalObjectStorage } from "../../../packages/storage/dist/index.js";

const json = (value) => ({ ok: true, status: 200, json: async () => value, body: null, headers: { get: () => null } });
const file = (bytes) => ({ ok: true, status: 200, json: async () => ({}), body: new Blob([bytes]).stream(), headers: { get: (n) => (n === "content-length" ? String(bytes.length) : null) } });

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (url.startsWith("https://api.pexels.com/videos/search")) return json({ videos: [{ id: 11, width: 3840, height: 2160, duration: 9, url: "https://www.pexels.com/video/11/", image: "https://images.pexels.com/v11.jpg", user: { name: "Ana" }, video_files: [{ file_type: "video/mp4", width: 640, height: 360, link: "https://videos.pexels.com/11-sd.mp4" }, { file_type: "video/mp4", width: 1920, height: 1080, link: "https://videos.pexels.com/11-hd.mp4" }, { file_type: "video/mp4", width: 3840, height: 2160, link: "https://videos.pexels.com/11-4k.mp4" }] }] });
    if (url.startsWith("https://pixabay.com/api/videos/?safesearch")) return json({ hits: [{ id: 22, duration: 5, pageURL: "https://pixabay.com/videos/22/", user: "Ben", tags: "city, night", videos: { large: { url: "https://cdn.pixabay.com/22-l.mp4", width: 1920, height: 1080, thumbnail: "https://cdn.pixabay.com/22.jpg" }, tiny: { url: "https://cdn.pixabay.com/22-t.mp4", width: 640, height: 360, thumbnail: "https://cdn.pixabay.com/22t.jpg" } } }] });
    if (url.startsWith("https://api.pexels.com/videos/videos/11")) return json({ id: 11, width: 3840, height: 2160, duration: 9, url: "https://www.pexels.com/video/11/", user: { name: "Ana" }, video_files: [{ file_type: "video/mp4", width: 1920, height: 1080, link: "https://videos.pexels.com/11-hd.mp4" }, { file_type: "video/mp4", width: 3840, height: 2160, link: "https://videos.pexels.com/11-4k.mp4" }] });
    if (url.startsWith("https://api.giphy.com/v1/gifs/abc")) return json({ data: { id: "abc", title: "Dance", url: "https://giphy.com/gifs/abc", username: "", images: { original: { width: "480", height: "270", mp4: "https://evil.example.com/x.mp4" } } } });
    if (url === "https://videos.pexels.com/11-hd.mp4") return { ok: false, status: 302, json: async () => ({}), body: null, headers: { get: (n) => (n === "location" ? "https://cdn.pexels.com/11-hd.mp4" : null) } };
    if (url === "https://cdn.pexels.com/11-hd.mp4") return file(Buffer.from("fake video bytes"));
    if (url === "https://videos.pexels.com/evil.mp4") return { ok: false, status: 302, json: async () => ({}), body: null, headers: { get: (n) => (n === "location" ? "http://169.254.169.254/latest" : null) } };
    if (url.startsWith("https://api.pexels.com/videos/videos/66")) return json({ id: 66, width: 1920, height: 1080, duration: 3, url: "https://www.pexels.com/video/66/", user: { name: "X" }, video_files: [{ file_type: "video/mp4", width: 1920, height: 1080, link: "https://videos.pexels.com/evil.mp4" }] });
    return { ok: false, status: 404, json: async () => ({}), body: null, headers: { get: () => null } };
  };
}

async function setup(keys) {
  const root = mkdtempSync(join(tmpdir(), "vc-stock-"));
  const saved = []; const calls = [];
  const server = Fastify();
  registerStockRoutes(server, {
    keys, fetch: fakeFetch(calls),
    assets: { listForProject: async () => saved, save: async (a) => { saved.push(a); } },
    storage: { resolve: (k) => join(root, k), putFile: async (from, key) => { mkdirSync(dirname(join(root, key)), { recursive: true }); copyFileSync(from, join(root, key)); return { key, checksumSha256: "x" }; }, remove: async () => {} },
    inspector: async () => ({ durationUs: 9_000_000, formatName: "mp4", sizeBytes: 16, hasVideo: true, hasAudio: false, width: 1920, height: 1080 }),
    authenticate: async (req) => (req.headers.authorization === "Bearer ok" ? { userId: "u" } : null),
    authorize: { canAccess: async (_p, projectId) => projectId === "p1" },
    clock: () => "2026-10-29T00:00:00Z",
  });
  return { server, saved, calls, root, close: async () => { await server.close(); rmSync(root, { recursive: true, force: true }); } };
}
const auth = { authorization: "Bearer ok" };

test("stock search merges the libraries that have keys and keeps keys on the server", async () => {
  const { server, calls, close } = await setup({ pexels: "PKEY", pixabay: "XKEY" });
  try {
    assert.equal((await server.inject({ url: "/v1/projects/p1/stock/search?q=city" })).statusCode, 401);
    assert.equal((await server.inject({ url: "/v1/projects/p2/stock/search?q=city", headers: auth })).statusCode, 403);
    const sources = (await server.inject({ url: "/v1/projects/p1/stock/sources", headers: auth })).json();
    assert.deepEqual(sources, { video: ["pexels", "pixabay"], photo: ["pexels", "pixabay"], gif: [] });
    const result = await server.inject({ url: "/v1/projects/p1/stock/search?q=city%20night&kind=video", headers: auth });
    assert.equal(result.statusCode, 200);
    const items = result.json().items;
    assert.deepEqual(items.map((i) => i.provider + ":" + i.id), ["pexels:11", "pixabay:22"]);
    assert.equal(items[0].previewUrl, "https://videos.pexels.com/11-sd.mp4");
    assert.ok(!result.body.includes("PKEY") && !result.body.includes("XKEY"), "keys never reach the browser");
    assert.equal(calls.find((c) => c.url.includes("pexels")).headers.authorization, "PKEY");
    assert.equal((await server.inject({ url: "/v1/projects/p1/stock/search?q=fun&kind=gif", headers: auth })).statusCode, 503, "no Giphy key, no GIF search");
  } finally { await close(); }
});

test("stock import re-fetches the item by id, downloads the HD file and stores it once with its credit", async () => {
  const { server, saved, root, close } = await setup({ pexels: "PKEY", giphy: "GKEY" });
  try {
    const first = await server.inject({ method: "POST", url: "/v1/projects/p1/stock/import", headers: auth, payload: { provider: "pexels", kind: "video", id: "11" } });
    assert.equal(first.statusCode, 201, first.body);
    const asset = first.json().asset;
    assert.equal(asset.kind, "video");
    assert.equal(asset.metadata.credit, "Ana on Pexels");
    assert.equal(asset.metadata.sourceUrl, "https://www.pexels.com/video/11/");
    assert.ok(existsSync(join(root, asset.storageKey)));
    const again = await server.inject({ method: "POST", url: "/v1/projects/p1/stock/import", headers: auth, payload: { provider: "pexels", kind: "video", id: "11" } });
    assert.equal(again.json().asset.id, asset.id, "importing twice reuses the asset");
    assert.equal(saved.length, 1);
    const bad = await server.inject({ method: "POST", url: "/v1/projects/p1/stock/import", headers: auth, payload: { provider: "giphy", kind: "gif", id: "abc" } });
    assert.equal(bad.statusCode, 502, "files on unexpected hosts are refused");
    const redirected = await server.inject({ method: "POST", url: "/v1/projects/p1/stock/import", headers: auth, payload: { provider: "pexels", kind: "video", id: "66" } });
    assert.equal(redirected.statusCode, 502, "a redirect off the libraries' hosts is refused");
    assert.equal((await server.inject({ method: "POST", url: "/v1/projects/p1/stock/import", headers: auth, payload: { provider: "pexels", kind: "video", id: "../x" } })).statusCode, 400);
  } finally { await close(); }
});

test("only https media hosts of the libraries are allowed", () => {
  assert.ok(allowedMediaUrl("https://videos.pexels.com/a.mp4"));
  assert.ok(allowedMediaUrl("https://media2.giphy.com/media/x/giphy.mp4"));
  assert.ok(allowedMediaUrl("https://cdn.pixabay.com/video/a.mp4"));
  for (const url of ["http://videos.pexels.com/a.mp4", "https://pexels.com.evil.io/a", "https://user:pw@cdn.pixabay.com/a", "https://cdn.pixabay.com:8443/a", "file:///etc/passwd", "https://169.254.169.254/"]) assert.equal(allowedMediaUrl(url), false, url);
});

test("face track route serves a stored track and says when tracking is not set up", async () => {
  const root = mkdtempSync(join(tmpdir(), "vc-faces-"));
  mkdirSync(join(root, "projects/p1/assets"), { recursive: true });
  writeFileSync(join(root, "projects/p1/assets/a1.faces.json"), JSON.stringify({ step: 0.5, boxes: [[0.1, 0.2, 0.3, 0.4], null] }));
  const server = Fastify();
  registerMediaRoutes(server, {
    assets: { listForProject: async () => [{ id: "a1", storageKey: "projects/p1/assets/a1.media", kind: "video", metadata: {} }, { id: "a2", storageKey: "projects/p1/assets/a2.media", kind: "video", metadata: {} }] },
    storage: new LocalObjectStorage(root), signingSecret: "s3cret-s3cret-s3cret",
    authenticate: async (req) => (req.headers.authorization === "Bearer ok" ? { userId: "u" } : null),
    authorize: { canAccess: async (_p, projectId) => projectId === "p1" },
  });
  try {
    assert.equal((await server.inject({ url: "/v1/projects/p1/assets/a1/faces" })).statusCode, 401);
    const stored = await server.inject({ url: "/v1/projects/p1/assets/a1/faces", headers: auth });
    assert.equal(stored.statusCode, 200);
    assert.deepEqual(stored.json().boxes, [[0.1, 0.2, 0.3, 0.4], null]);
    assert.equal((await server.inject({ url: "/v1/projects/p1/assets/a2/faces", headers: auth })).statusCode, 503);
    // A stored preview matte is found and served with a signed, range-capable link.
    writeFileSync(join(root, "projects/p1/assets/a1.matte.mp4"), "matte-bytes");
    const issued = await server.inject({ url: "/v1/projects/p1/assets/a1/matte-url", headers: auth });
    assert.equal(issued.statusCode, 200, issued.body);
    const media = await server.inject({ url: issued.json().url, headers: { range: "bytes=0-4" } });
    assert.equal(media.statusCode, 206); assert.equal(media.body, "matte");
    assert.equal((await server.inject({ url: issued.json().url.replace(/signature=[^&]+/, "signature=bad") })).statusCode, 401);
    assert.equal((await server.inject({ url: "/v1/projects/p1/assets/a2/matte-url", headers: auth })).statusCode, 503, "no matte and no matting set up");
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});
