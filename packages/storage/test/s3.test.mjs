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


test("S3 listing follows continuation tokens", async () => {
  const pages = [
    { Contents: [{ Key: "renders/a.mp4", Size: 1, LastModified: new Date("2026-01-01T00:00:00Z") }], IsTruncated: true, NextContinuationToken: "page-2" },
    { Contents: [{ Key: "renders/b.mp4", Size: 2, LastModified: new Date("2026-02-01T00:00:00Z") }], IsTruncated: false }
  ];
  const commands = [];
  const client = { send: async (command) => { commands.push(command); return pages.shift(); } };
  const storage = new S3ObjectStorage({ bucket: "videocraft-test", region: "us-east-1", client });
  const objects = await storage.list("renders/");
  assert.deepEqual(objects.map((object) => object.key), ["renders/a.mp4", "renders/b.mp4"]);
  assert.equal(commands[1].input.ContinuationToken, "page-2");
});


test("S3 adapter can stage a streamed object for workers", async () => {
  const commands = [];
  const client = {
    send: async (command) => {
      commands.push(command);
      return { Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("hello")); controller.close(); } }) } };
    }
  };
  const directory = await mkdtemp(join(tmpdir(), "videocraft-s3-download-"));
  const destination = join(directory, "staged.bin");
  try {
    const storage = new S3ObjectStorage({ bucket: "videocraft-test", region: "us-east-1", client });
    await storage.downloadToFile("projects/p1/source.bin", destination);
    assert.equal(await (await import("node:fs/promises")).readFile(destination, "utf8"), "hello");
    assert.equal(commands[0].input.Key, "projects/p1/source.bin");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('attachment URLs carry a signed filename and reject header injection', async () => {
  const {S3Client}=await import('@aws-sdk/client-s3');
  const client=new S3Client({region:'us-east-1',endpoint:'https://storage.example',credentials:{accessKeyId:'test-key',secretAccessKey:'test-secret'}});
  const storage=new S3ObjectStorage({bucket:'test',region:'us-east-1',client});
  const url=new URL(await storage.createDownloadUrl('projects/p/renders/out.mp4',300,{filename:'videocraft-export.mp4'}));
  assert.equal(url.searchParams.get('response-content-disposition'),'attachment; filename="videocraft-export.mp4"');
  await assert.rejects(storage.createDownloadUrl('out.mp4',300,{filename:'bad\r\nheader'}),/filename/);
  client.destroy();
});
