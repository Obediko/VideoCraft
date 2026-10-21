import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3ObjectStorage } from "../dist/s3.js";

test("S3 adapter uploads and removes through the provider client", async () => {
  const commands = [];
  const client = { send: async (command) => { commands.push(command); return {}; } };
  const directory = await mkdtemp(join(tmpdir(), "videocraft-s3-"));
  const source = join(directory, "source.bin");
  await writeFile(source, "hello");
  try {
    const storage = new S3ObjectStorage({
      bucket: "videocraft-test",
      region: "us-east-1",
      client
    });
    const stored = await storage.putFile(source, "projects/p1/source.bin");
    assert.equal(stored.size, 5);
    assert.equal(stored.checksumSha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    assert.equal(commands[0].input.Bucket, "videocraft-test");
    assert.equal(commands[0].input.Key, "projects/p1/source.bin");
    await storage.remove("projects/p1/source.bin");
    assert.equal(commands[1].input.Key, "projects/p1/source.bin");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
