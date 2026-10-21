import test from "node:test";
import assert from "node:assert/strict";
import { parseClamAvResponse } from "../dist/index.js";

test("recognizes a clean ClamAV stream", () => {
  assert.deepEqual(parseClamAvResponse("stream: OK\n"), { clean: true });
});
test("recognizes an infected ClamAV stream", () => {
  assert.deepEqual(parseClamAvResponse("stream: Eicar-Test-Signature FOUND\n"), { clean: false, signature: "Eicar-Test-Signature" });
});
test("rejects malformed ClamAV output", () => {
  assert.equal(parseClamAvResponse("unexpected"), undefined);
});
