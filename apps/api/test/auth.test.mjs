import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { JwtAuthenticator } from "../dist/auth.js";

const primary = "primary-secret-012345678901234567890123";
const previous = "previous-secret-012345678901234567890123";

async function token(secret, subject) {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(subject).sign(new TextEncoder().encode(secret));
}

test("JWT authentication accepts the previous secret during overlap rotation", async () => {
  const authenticator = new JwtAuthenticator([primary, previous]);
  const request = { headers: { authorization: "Bearer " + await token(previous, "user-previous") } };
  assert.deepEqual(await authenticator.authenticate(request), { userId: "user-previous" });
});

test("JWT authentication rejects tokens signed by retired secrets", async () => {
  const authenticator = new JwtAuthenticator([primary, previous]);
  const request = { headers: { authorization: "Bearer " + await token("retired-secret-0123456789012345678901", "user-retired") } };
  assert.equal(await authenticator.authenticate(request), null);
});
