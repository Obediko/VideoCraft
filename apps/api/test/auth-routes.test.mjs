import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { parseAllowedEmails, registerAuthRoutes } from "../dist/auth-routes.js";

const secret = "test-secret-0123456789012345678901234567";
function fakeDatabase() {
  const users = [];
  return {
    users,
    async query(sql, params = []) {
      if (sql.startsWith("INSERT INTO users")) { users.push({ id: params[0], email: params[1], password_hash: params[2] }); return { rows: [] }; }
      if (sql.startsWith("SELECT id, email, password_hash")) return { rows: users.filter((user) => user.email === params[0]) };
      return { rows: [] };
    },
  };
}
async function app(options) {
  const server = Fastify({ trustProxy: ["127.0.0.0/8"] });
  await server.register(rateLimit, { global: true, max: 1000, timeWindow: "1 minute" });
  registerAuthRoutes(server, { database: fakeDatabase(), secret, ...options });
  await server.ready();
  return server;
}
const post = (server, url, body, ip = "203.0.113.7") => server.inject({ method: "POST", url, payload: body, headers: { "x-forwarded-for": ip } });

test("allowlist parsing defaults to closed in production and open in development", () => {
  assert.deepEqual(parseAllowedEmails(undefined, true), []);
  assert.equal(parseAllowedEmails(undefined, false), "*");
  assert.equal(parseAllowedEmails(" * ", true), "*");
  assert.deepEqual(parseAllowedEmails("A@x.org, b@y.org ,", true), ["a@x.org", "b@y.org"]);
});

test("registration is refused for emails outside the allowlist", async () => {
  const server = await app({ allowedEmails: ["owner@example.org"] });
  const denied = await post(server, "/auth/register", { email: "stranger@example.org", password: "correct horse battery" });
  assert.equal(denied.statusCode, 403);
  const allowed = await post(server, "/auth/register", { email: "Owner@Example.org", password: "correct horse battery" });
  assert.equal(allowed.statusCode, 201);
  assert.match(allowed.headers["set-cookie"], /HttpOnly; Secure; SameSite=Lax/);
  await server.close();
});

test("login attempts are rate limited per client IP", async () => {
  const server = await app({ rateLimitMax: 3 });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post(server, "/auth/login", { email: "a@b.org", password: "wrong-password-123" })).statusCode);
  assert.deepEqual(codes, [401, 401, 401, 429]);
  assert.equal((await post(server, "/auth/login", { email: "a@b.org", password: "wrong-password-123" }, "198.51.100.9")).statusCode, 401);
  await server.close();
});
