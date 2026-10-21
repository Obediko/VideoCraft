import test from "node:test";
import assert from "node:assert/strict";
import { safeMediaPath } from "../dist/index.js";

test("media path resolver prevents traversal", () => {
  assert.equal(safeMediaPath("/media", "project/video.mp4"), "/media/project/video.mp4");
  assert.throws(() => safeMediaPath("/media", "../secret.mp4"), /escapes/);
  assert.throws(() => safeMediaPath("/media", "C:\\secret.mp4"), /Invalid/);
});
