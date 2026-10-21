import test from "node:test";
import assert from "node:assert/strict";
import { pruneExpiredObjects } from "../dist/index.js";

function storage(objects) {
  const removed = [];
  return {
    removed,
    async list() { return objects; },
    async remove(key) { removed.push(key); }
  };
}

test("retention deletes only expired, unprotected objects within a bound", async () => {
  const adapter = storage([
    { key: "renders/old.mp4", size: 10, lastModified: "2026-01-01T00:00:00.000Z" },
    { key: "renders/protected.mp4", size: 10, lastModified: "2026-01-01T00:00:00.000Z" },
    { key: "renders/new.mp4", size: 10, lastModified: "2026-10-20T00:00:00.000Z" }
  ]);
  const result = await pruneExpiredObjects(adapter, {
    prefix: "renders/",
    olderThan: "2026-10-01T00:00:00.000Z",
    protectedKeys: new Set(["renders/protected.mp4"]),
    maxDeletes: 1
  });
  assert.deepEqual(result, { examined: 3, eligible: 2, deleted: ["renders/old.mp4"], skippedProtected: 1, remainingEligible: 0 });
  assert.deepEqual(adapter.removed, ["renders/old.mp4"]);
});

test("retention refuses unbounded or unsupported cleanup", async () => {
  await assert.rejects(() => pruneExpiredObjects({ remove: async () => {} }, { olderThan: "2026-10-01T00:00:00.000Z" }), /listing/);
  await assert.rejects(() => pruneExpiredObjects(storage([]), { olderThan: "not-a-date" }), /valid ISO/);
  await assert.rejects(() => pruneExpiredObjects(storage([]), { olderThan: "2026-10-01T00:00:00.000Z", maxDeletes: 0 }), /maxDeletes/);
});
