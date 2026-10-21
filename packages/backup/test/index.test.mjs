import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalObjectStorage } from "@videocraft/storage";
import { verifyBackup } from "../dist/index.js";

test("backup verification checks size, checksum, and restore inspector", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocraft-backup-"));
  const storage = new LocalObjectStorage(root);
  const source = join(root, "source.dump");
  const content = "backup-content";
  await writeFile(source, content);
  const stored = await storage.putFile(source, "backups/latest.dump");
  const verified = [];
  const result = await verifyBackup(storage, { verify: async (path) => { verified.push(path); } }, {
    storageKey: stored.key,
    expectedSha256: stored.checksumSha256,
    expectedSizeBytes: stored.size
  }, join(root, "staged.dump"));
  assert.equal(result.verified, true);
  assert.equal(result.sizeBytes, content.length);
  assert.equal(verified.length, 1);
});

test("backup verification fails closed on manifest mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocraft-backup-"));
  const storage = new LocalObjectStorage(root);
  const source = join(root, "source.dump");
  await writeFile(source, "backup-content");
  const stored = await storage.putFile(source, "backups/latest.dump");
  await assert.rejects(() => verifyBackup(storage, { verify: async () => {} }, {
    storageKey: stored.key,
    expectedSha256: createHash("sha256").update("wrong").digest("hex"),
    expectedSizeBytes: stored.size
  }, join(root, "staged.dump")), /checksum/);
});
