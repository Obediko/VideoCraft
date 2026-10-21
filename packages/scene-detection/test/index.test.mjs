import test from "node:test";
import assert from "node:assert/strict";

test("scene detection package test harness is wired", () => {
  assert.equal(typeof test, "function");
});
