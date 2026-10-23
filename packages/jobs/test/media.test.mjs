import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue, Worker } from "bullmq";
import { BullMqMediaQueue, CloudflareMediaQueue, isMediaTask, processProxyTask, proxyTask } from "../dist/index.js";
import { createProxy, probeMedia, isBrowserPlayable } from "@videocraft/analysis";
import { LocalObjectStorage } from "@videocraft/storage";
import { InMemoryAssetRepository } from "@videocraft/application";

const haveRedis = Boolean(process.env.REDIS_URL) || spawnSync("redis-server", ["--version"]).status === 0;

async function withRedis(run) {
  // Use a provided Redis (CI service) when there is one; otherwise start a throwaway local server.
  if (process.env.REDIS_URL) { const url = new URL(process.env.REDIS_URL); return run({ host: url.hostname, port: Number(url.port || 6379) }); }
  const dir = mkdtempSync(join(tmpdir(), "vc-redis-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no", "--dir", dir], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50 && spawnSync("redis-cli", ["-p", String(port), "ping"]).stdout?.toString().trim() !== "PONG"; i += 1) await new Promise((r) => setTimeout(r, 100));
    await run({ host: "127.0.0.1", port });
  } finally { server.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
}

test("real BullMQ: proxies are built by a worker, retried after a transient failure, failed only on the last attempt, and de-duplicated", { skip: !haveRedis && "redis-server not installed", timeout: 120_000 }, async () => {
  await withRedis(async (connection) => {
    const dir = mkdtempSync(join(tmpdir(), "vc-mediaq-"));
    const storage = new LocalObjectStorage(join(dir, "media"));
    const assets = new InMemoryAssetRepository();
    const source = join(dir, "clip.mkv");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=2:r=25", "-c:v", "mpeg4", source]);
    const add = async (id) => {
      const key = "projects/p1/assets/" + id + ".media";
      await storage.putFile(source, key);
      const asset = { id, projectId: "p1", kind: "video", storageKey: key, checksumSha256: "a".repeat(64), metadata: { proxyStatus: "pending", filename: id + ".mkv" }, createdAt: new Date().toISOString() };
      await assets.save(asset);
      return asset;
    };
    const flaky = new Map();
    const name = "media-test-" + Date.now();
    const queue = new Queue(name, { connection });
    const producer = new BullMqMediaQueue(queue, { attempts: 3, backoffMs: 50 });
    const seen = [];
    const worker = new Worker(name, async (job) => {
      seen.push([job.data.assetId, job.attemptsMade]);
      return processProxyTask(job.data, {
        storage, assets,
        makeProxy: async (input, output) => {
          if (job.data.assetId === "broken") throw new Error("codec exploded");
          if (job.data.assetId === "flaky" && !flaky.get("done")) { flaky.set("done", true); throw new Error("transient"); }
          await createProxy(input, output);
        },
      }, { final: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) });
    }, { connection, concurrency: 2 });
    const statusOf = async (id) => (await assets.listForProject("p1")).find((a) => a.id === id).metadata;
    const until = async (predicate, ms = 60_000) => { const start = Date.now(); while (!(await predicate())) { if (Date.now() - start > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 100)); } };
    try {
      const good = await add("good"); const flakyAsset = await add("flaky"); const broken = await add("broken");
      await producer.enqueueProxy(good);
      await producer.enqueueProxy(good); // same asset twice: one job
      await producer.enqueueProxy(flakyAsset);
      await producer.enqueueProxy(broken);

      await until(async () => (await statusOf("good")).proxyStatus === "ready");
      const proxy = await probeMedia(storage.resolve((await statusOf("good")).proxyKey));
      assert.equal(isBrowserPlayable(proxy), true, "worker output is a browser-playable proxy");

      await until(async () => (await statusOf("flaky")).proxyStatus === "ready");
      assert.deepEqual(seen.filter(([id]) => id === "flaky").map(([, n]) => n), [0, 1], "retried once after the transient failure");

      await until(async () => (await statusOf("broken")).proxyStatus === "failed");
      assert.deepEqual(seen.filter(([id]) => id === "broken").map(([, n]) => n), [0, 1, 2], "three attempts, failure recorded on the last");
      assert.equal(seen.filter(([id]) => id === "good").length, 1, "duplicate enqueue ran once");
      assert.equal(await processProxyTask(proxyTask(good), { storage, assets, makeProxy: async () => { throw new Error("must not run"); } }), "skipped", "a ready proxy is not rebuilt");
    } finally { await worker.close(); await queue.obliterate({ force: true }).catch(() => {}); await queue.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

test("Cloudflare producer publishes a typed media task that the consumer can tell apart from renders", async () => {
  const calls = [];
  const producer = new CloudflareMediaQueue({ accountId: "acc", queueId: "q", apiToken: "t", fetchFn: async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, status: 200 }; } });
  await producer.enqueueProxy({ id: "a1", projectId: "p1", storageKey: "projects/p1/assets/a1.media" });
  assert.equal(calls[0][0], "https://api.cloudflare.com/client/v4/accounts/acc/queues/q/messages");
  assert.deepEqual(calls[0][1], { body: { type: "proxy", jobId: "proxy-a1", assetId: "a1", projectId: "p1", storageKey: "projects/p1/assets/a1.media" } });
  assert.equal(isMediaTask(calls[0][1].body), true);
  assert.equal(isMediaTask({ jobId: "render-1", project: {}, revision: {} }), false);
  const failing = new CloudflareMediaQueue({ accountId: "a", queueId: "q", apiToken: "t", fetchFn: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(failing.enqueueProxy({ id: "a", projectId: "p", storageKey: "k" }), /HTTP 500/);
});

test("remote object storage: the proxy task stages the object instead of resolving a local path", async () => {
  const assets = new InMemoryAssetRepository();
  const asset = { id: "remote-1", projectId: "p1", kind: "video", storageKey: "projects/p1/assets/remote-1.media", checksumSha256: "b".repeat(64), metadata: { proxyStatus: "pending" }, createdAt: new Date().toISOString() };
  await assets.save(asset);
  const uploaded = [];
  const storage = {
    resolve() { throw new Error("S3 objects are not local filesystem paths"); },
    async downloadToFile(key, path) { const { writeFile } = await import("node:fs/promises"); await writeFile(path, "media:" + key); },
    async putFile(path, key) { uploaded.push(key); },
  };
  const workRoot = mkdtempSync(join(tmpdir(), "vc-remote-"));
  try {
    const outcome = await processProxyTask(proxyTask(asset), { assets, storage, workRoot, makeProxy: async (input, output) => { const { copyFile } = await import("node:fs/promises"); await copyFile(input, output); } });
    assert.equal(outcome, "ready");
    assert.deepEqual(uploaded, ["projects/p1/assets/remote-1.proxy.mp4"]);
    assert.equal((await assets.listForProject("p1")).find((a) => a.id === "remote-1").metadata.proxyStatus, "ready");
  } finally { rmSync(workRoot, { recursive: true, force: true }); }
});
