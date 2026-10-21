import test from "node:test";
import assert from "node:assert/strict";

test("strategy test harness is wired", () => {
  assert.equal(typeof test, "function");
});
