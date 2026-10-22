import test from "node:test";
import assert from "node:assert/strict";
import { parseSilence } from "../dist/index.js";

test("media analysis package has a stable public surface", async () => {
  assert.equal(typeof (await import("../dist/index.js")).FfprobeMediaAnalyzer, "function");
});
