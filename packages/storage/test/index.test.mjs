import test from "node:test";
import assert from "node:assert/strict";
import { safeObjectPath } from "../dist/index.js";

test("object keys stay inside the storage root", () => {
  assert.equal(safeObjectPath("/objects", "projects/p1/source.mp4"), "/objects/projects/p1/source.mp4");
  assert.throws(() => safeObjectPath("/objects", "../secret"), /escapes/);
  assert.throws(() => safeObjectPath("/objects", ".env"), /Reserved/);
});
