import test from "node:test";
import assert from "node:assert/strict";
import { EnvironmentSecretProvider, parseClamAvResponse, requireSecret } from "../dist/index.js";

test("recognizes a clean ClamAV stream", () => {
  assert.deepEqual(parseClamAvResponse("stream: OK\n"), { clean: true });
});
test("recognizes an infected ClamAV stream", () => {
  assert.deepEqual(parseClamAvResponse("stream: Eicar-Test-Signature FOUND\n"), { clean: false, signature: "Eicar-Test-Signature" });
});
test("rejects malformed ClamAV output", () => {
  assert.equal(parseClamAvResponse("unexpected"), undefined);
});


test("environment secrets are trimmed and required values fail closed", () => {
  const provider = new EnvironmentSecretProvider({ TOKEN: "  secret-value  ", EMPTY: "   " });
  assert.equal(provider.get("TOKEN"), "secret-value");
  assert.equal(provider.get("EMPTY"), undefined);
  assert.equal(requireSecret(provider, "TOKEN", 8), "secret-value");
  assert.throws(() => requireSecret(provider, "EMPTY"), /EMPTY is required/);
  assert.throws(() => requireSecret(provider, "TOKEN", 20), /at least 20/);
});
