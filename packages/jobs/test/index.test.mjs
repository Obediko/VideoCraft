import test from "node:test";
import assert from "node:assert/strict";
import { BullMqRenderQueue } from "../dist/index.js";

test("render queue uses deterministic idempotency job IDs", async () => {
  const calls = [];
  const queue = {
    async getJob() { return undefined; },
    async add(name, data, options) { calls.push({ name, data, options }); return { id: options.jobId }; }
  };
  const renderer = new BullMqRenderQueue(queue);
  const input = {
    project: { id: "p", ownerId: "o", name: "Demo", revision: 1, createdAt: "", updatedAt: "" },
    revision: { projectId: "p", revision: 1, timeline: { durationUs: 100, tracks: [] }, acceptedProposalIds: [], createdAt: "", createdBy: "o" },
    settings: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 },
    idempotencyKey: "same-request"
  };
  const first = await renderer.enqueue(input);
  const second = await renderer.enqueue(input);
  assert.equal(first.id, second.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.jobId, calls[1].options.jobId);
});
