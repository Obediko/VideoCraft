import test from "node:test";
import assert from "node:assert/strict";

test("media analysis package has a stable public surface", async () => {
  assert.equal(typeof (await import("../dist/index.js")).FfprobeMediaAnalyzer, "function");
});
