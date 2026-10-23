import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerUploadRoutes } from "../dist/uploads.js";
import { registerMediaRoutes } from "../dist/media-routes.js";
import { createProxy, probeMedia, isBrowserPlayable } from "@videocraft/analysis";
import { LocalObjectStorage } from "@videocraft/storage";
import { InMemoryAssetRepository } from "@videocraft/application";

test("isBrowserPlayable accepts H.264 MP4 and flags other formats and 4K", () => {
  const base = { durationUs: 1, sizeBytes: 1, hasVideo: true, hasAudio: true, formatName: "mov,mp4,m4a,3gp,3g2,mj2", videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080 };
  assert.equal(isBrowserPlayable(base), true);
  assert.equal(isBrowserPlayable({ ...base, width: 1080, height: 1920 }), true, "vertical 1080p is fine");
  assert.equal(isBrowserPlayable({ ...base, videoCodec: "hevc" }), false);
  assert.equal(isBrowserPlayable({ ...base, formatName: "matroska,webm", videoCodec: "vp9", audioCodec: "opus" }), false);
  assert.equal(isBrowserPlayable({ ...base, audioCodec: "pcm_s16le" }), false);
  assert.equal(isBrowserPlayable({ ...base, width: 3840, height: 2160 }), false);
});

test("real upload: a non-browser format gets a playable H.264 proxy, served with the right type and ranges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-proxy-"));
  const source = join(dir, "clip.mkv");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:d=3:r=25", "-f", "lavfi", "-i", "sine=f=440:d=3", "-c:v", "mpeg4", "-c:a", "pcm_s16le", "-shortest", source]);
  const assets = new InMemoryAssetRepository();
  const storage = new LocalObjectStorage(join(dir, "media"));
  const done = new Promise((resolve) => { globalThis.__proxyDone = resolve; });
  const server = Fastify();
  const deps = { authenticate: async () => ({ userId: "u" }), authorize: { canAccess: async () => true } };
  registerUploadRoutes(server, { ...deps, assets, storage, clock: () => new Date().toISOString(), inspector: (p) => probeMedia(p), proxy: (i, o) => createProxy(i, o), onBackgroundDone: (id, outcome, error) => globalThis.__proxyDone({ id, outcome, error }) });
  registerMediaRoutes(server, { ...deps, assets, storage, signingSecret: "secret-secret-secret-secret" });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const base = "http://127.0.0.1:" + server.server.address().port;
  try {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(source)], { type: "video/x-matroska" }), "clip.mkv");
    const uploaded = await fetch(base + "/v1/projects/p1/assets/upload?kind=video", { method: "POST", body: form });
    assert.equal(uploaded.status, 201);
    const { asset } = await uploaded.json();
    assert.equal(asset.metadata.proxyStatus, "pending");
    const early = await fetch(base + "/v1/projects/p1/assets/" + asset.id + "/playback-url");
    if (early.status === 202) assert.equal((await early.json()).pending, true);

    const outcome = await done;
    assert.equal(outcome.outcome, "ready", String(outcome.error));
    const stored = (await assets.listForProject("p1"))[0];
    assert.equal(stored.metadata.proxyStatus, "ready");
    assert.ok((await assets.listStorageKeys()).includes(stored.metadata.proxyKey), "retention sees the proxy as referenced");

    const issued = await (await fetch(base + "/v1/projects/p1/assets/" + asset.id + "/playback-url")).json();
    assert.equal(issued.proxy, true);
    const media = await fetch(base + issued.url);
    assert.equal(media.headers.get("content-type"), "video/mp4");
    const out = join(dir, "served.mp4");
    writeFileSync(out, Buffer.from(await media.arrayBuffer()));
    const probe = await probeMedia(out);
    assert.equal(probe.videoCodec, "h264");
    assert.equal(probe.audioCodec, "aac");
    assert.equal(isBrowserPlayable(probe), true);
    assert.ok(Math.abs(probe.durationUs - 3_000_000) < 200_000);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an H.264 MP4 upload needs no proxy and is served with its declared type", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-noproxy-"));
  const source = join(dir, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=1:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
  const assets = new InMemoryAssetRepository();
  const storage = new LocalObjectStorage(join(dir, "media"));
  const server = Fastify();
  const deps = { authenticate: async () => ({ userId: "u" }), authorize: { canAccess: async () => true } };
  let proxied = false;
  registerUploadRoutes(server, { ...deps, assets, storage, clock: () => new Date().toISOString(), inspector: (p) => probeMedia(p), proxy: async () => { proxied = true; } });
  registerMediaRoutes(server, { ...deps, assets, storage, signingSecret: "secret-secret-secret-secret" });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const base = "http://127.0.0.1:" + server.server.address().port;
  try {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(source)], { type: "video/mp4" }), "clip.mp4");
    const { asset } = await (await fetch(base + "/v1/projects/p1/assets/upload?kind=video", { method: "POST", body: form })).json();
    assert.equal(asset.metadata.proxyStatus, undefined);
    const issued = await (await fetch(base + "/v1/projects/p1/assets/" + asset.id + "/playback-url")).json();
    assert.equal(issued.proxy, false);
    assert.equal((await fetch(base + issued.url)).headers.get("content-type"), "video/mp4");
    assert.equal(proxied, false);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("image uploads must decode as a still image", async () => {
  const { isStillImage } = await import("@videocraft/analysis");
  const dir = mkdtempSync(join(tmpdir(), "vc-img-"));
  const png = join(dir, "a.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", png]);
  const server = Fastify();
  registerUploadRoutes(server, { authenticate: async () => ({ userId: "u" }), authorize: { canAccess: async () => true }, assets: new InMemoryAssetRepository(), storage: new LocalObjectStorage(join(dir, "media")), clock: () => new Date().toISOString(), inspector: (p) => probeMedia(p), imageInspector: (p) => isStillImage(p) });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const base = "http://127.0.0.1:" + server.server.address().port;
  const send = async (bytes, name) => { const form = new FormData(); form.append("file", new Blob([bytes]), name); return (await fetch(base + "/v1/projects/p1/assets/upload?kind=image", { method: "POST", body: form })).status; };
  try {
    assert.equal(await send(readFileSync(png), "a.png"), 201);
    assert.equal(await send(Buffer.from("not an image"), "fake.png"), 422);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
