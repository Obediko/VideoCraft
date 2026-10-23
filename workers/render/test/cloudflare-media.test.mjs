import test from "node:test";
import assert from "node:assert/strict";
import { parseTask, runCloudflarePullConsumer } from "../dist/cloudflare-pull.js";

async function consumeOnce(message, media) {
  process.env.CF_ACCOUNT_ID = "acc"; process.env.CF_QUEUE_ID = "q"; process.env.CF_QUEUES_API_TOKEN = "t"; process.env.CF_QUEUE_POLL_INTERVAL_MS = "250";
  const controller = new AbortController();
  const acked = [];
  let pulls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.endsWith("/pull")) { pulls += 1; return ok({ success: true, result: { messages: pulls === 1 ? [message] : [] } }); }
    acked.push(JSON.parse(init.body)); controller.abort(); return ok({ success: true });
  };
  try { await runCloudflarePullConsumer({ process: async () => { throw new Error("render processor must not see media tasks"); } }, controller.signal, media); }
  finally { globalThis.fetch = realFetch; }
  return acked[0];
}

const task = { type: "proxy", jobId: "proxy-a1", assetId: "a1", projectId: "p1", storageKey: "projects/p1/assets/a1.media" };

test("media messages are parsed apart from render tasks", () => {
  assert.deepEqual(parseTask(JSON.stringify({ body: task })), task);
  assert.equal(parseTask({ jobId: "render-1" }).jobId, "render-1");
  assert.throws(() => parseTask({ nope: true }), /not a render task/);
});

test("Cloudflare consumer routes media tasks to the media processor: ack on success, retry early failures, ack the last failure", async () => {
  const calls = [];
  const media = (fail) => ({ process: async (t, attempt) => { calls.push([t.assetId, attempt.final]); if (fail) throw new Error("boom"); return "ready"; } });
  assert.deepEqual(await consumeOnce({ body: task, lease_id: "L1", id: "m1", attempts: 1 }, media(false)), { acks: [{ lease_id: "L1" }], retries: [] });
  const early = await consumeOnce({ body: task, lease_id: "L2", id: "m2", attempts: 1 }, media(true));
  assert.equal(early.acks.length, 0); assert.equal(early.retries[0].lease_id, "L2");
  assert.deepEqual(await consumeOnce({ body: task, lease_id: "L3", id: "m3", attempts: 3 }, media(true)), { acks: [{ lease_id: "L3" }], retries: [] }, "the final attempt is acknowledged so it does not loop forever");
  assert.deepEqual(calls, [["a1", false], ["a1", false], ["a1", true]]);
});
