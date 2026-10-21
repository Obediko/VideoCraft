import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalObjectStorage } from "../dist/index.js";
import { safeObjectPath } from "../dist/index.js";

test("object keys stay inside the storage root", () => {
  assert.equal(safeObjectPath("/objects", "projects/p1/source.mp4"), "/objects/projects/p1/source.mp4");
  assert.throws(() => safeObjectPath("/objects", "../secret"), /escapes/);
  assert.throws(() => safeObjectPath("/objects", ".env"), /Reserved/);
});


test("local storage can stage an object for media workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocraft-storage-"));
  const source = join(root, "source.bin");
  const destination = join(root, "work.bin");
  await writeFile(source, "media");
  const storage = new LocalObjectStorage(join(root, "objects"));
  await storage.putFile(source, "projects/p1/source.bin");
  await storage.downloadToFile("projects/p1/source.bin", destination);
  assert.equal(await readFile(destination, "utf8"), "media");
});
