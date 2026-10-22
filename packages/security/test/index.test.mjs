import test from "node:test";
import assert from "node:assert/strict";
import { AwsSecretsManagerProvider, EnvironmentSecretProvider, loadSecretEnvironment, parseClamAvResponse, requireSecret } from "../dist/index.js";

test("recognizes a clean ClamAV stream", () => {
  assert.deepEqual(parseClamAvResponse("stream: OK\n"), { clean: true });
});
test("recognizes an infected ClamAV stream", () => {
  assert.deepEqual(parseClamAvResponse("stream: Eicar-Test-Signature FOUND\n"), { clean: false, signature: "Eicar-Test-Signature" });
});
test("recognizes zINSTREAM null-terminated responses", () => {
  assert.deepEqual(parseClamAvResponse("stream: OK\0"), { clean: true });
  assert.deepEqual(parseClamAvResponse("stream: Eicar-Test-Signature FOUND\0"), { clean: false, signature: "Eicar-Test-Signature" });
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


test("environment secret loading preserves injected values", async () => {
  const loaded = await loadSecretEnvironment({ SECRET_PROVIDER: "env", AUTH_JWT_SECRET: "value" });
  assert.equal(loaded.AUTH_JWT_SECRET, "value");
});

test("unknown secret providers fail closed", async () => {
  await assert.rejects(() => loadSecretEnvironment({ SECRET_PROVIDER: "unknown" }), /Unsupported SECRET_PROVIDER/);
});


test("AWS secrets-manager adapter parses a JSON secret object", async () => {
  const provider = new AwsSecretsManagerProvider("videocraft/test", "us-east-1", {
    async send() { return { SecretString: JSON.stringify({ INTENT_PROVIDER_API_KEY: "test-key", S3_BUCKET: "media" }) }; }
  });
  assert.deepEqual(await provider.load(), { INTENT_PROVIDER_API_KEY: "test-key", S3_BUCKET: "media" });
});

test("AWS secrets-manager adapter rejects non-object secret payloads", async () => {
  const provider = new AwsSecretsManagerProvider("videocraft/test", "us-east-1", {
    async send() { return { SecretString: JSON.stringify({ INVALID: 123 }) }; }
  });
  await assert.rejects(() => provider.load(), /only string values/);
});


test("Redis provider quota is atomic and reports exhaustion", async () => {
  let current = 0;
  const calls = [];
  const quota = new (await import("../dist/index.js")).RedisProviderQuota({
    async eval(script, numberOfKeys, ...args) {
      calls.push({ script, numberOfKeys, args });
      current += 1;
      return current;
    }
  });
  const first = await quota.consume("intent:user-1", 2, 60);
  const second = await quota.consume("intent:user-1", 2, 60);
  const third = await quota.consume("intent:user-1", 2, 60);
  assert.equal(first.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(third.allowed, false);
  assert.equal(calls[0].numberOfKeys, 1);
  assert.match(calls[0].args[0], /intent%3Auser-1/);
});
