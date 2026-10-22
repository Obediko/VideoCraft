import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "@videocraft/persistence";

function scrypt(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, keylen, options, (error, key) => error ? reject(error) : resolve(key)));
}
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_COOKIE = "videocraft_refresh";
type AuthOptions = { database: Database; secret: string; issuer?: string; audience?: string; allowedEmails?: string[] | "*"; rateLimitMax?: number };
type UserRow = { id: string; email: string; password_hash: string; created_at: string };
type RequestBody = { email?: unknown; password?: unknown };

export function registerAuthRoutes(server: FastifyInstance, options: AuthOptions): void {
  // Per-IP limit for credential endpoints, independent of any bearer header (requires @fastify/rate-limit to be registered first).
  const limited = { config: { rateLimit: { max: options.rateLimitMax ?? 10, timeWindow: "1 minute", keyGenerator: (request: FastifyRequest) => "auth:" + request.ip } } } as any;
  const allowed = options.allowedEmails ?? "*";
  server.post("/auth/register", limited, async (request, reply) => {
    const body = request.body as RequestBody;
    const email = normalizeEmail(body?.email);
    const password = validPassword(body?.password);
    if (!email || !password || password.length > 128) return authError(reply, 400, "Use a valid email and a password of 10–128 characters");
    if (allowed !== "*" && !allowed.includes(email)) return authError(reply, 403, "Registration is invite-only for this site");
    const userId = randomUUID();
    try {
      await options.database.query("INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, NOW())", [userId, email, await hashPassword(password)]);
    } catch (error) {
      if (isUniqueViolation(error)) return authError(reply, 409, "An account with that email already exists");
      request.log.error({ error }, "user registration failed");
      return authError(reply, 500, "Unable to create account");
    }
    const user = { id: userId, email };
    const accessToken = await signAccessToken(options, user);
    await setRefreshCookie(reply, options.database, userId);
    return reply.code(201).send({ user, accessToken });
  });

  server.post("/auth/login", limited, async (request, reply) => {
    const body = request.body as RequestBody;
    const email = normalizeEmail(body?.email);
    const password = validPassword(body?.password);
    if (!email || !password) return authError(reply, 401, "Invalid email or password");
    const result = await options.database.query<UserRow>("SELECT id, email, password_hash, created_at FROM users WHERE email = $1 AND disabled_at IS NULL", [email]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) return authError(reply, 401, "Invalid email or password");
    const accessToken = await signAccessToken(options, user);
    await setRefreshCookie(reply, options.database, user.id);
    return { user: { id: user.id, email: user.email }, accessToken };
  });

  server.post("/auth/refresh", limited, async (request, reply) => {
    const presented = readCookie(request.headers.cookie, REFRESH_COOKIE);
    if (!presented) return authError(reply, 401, "Refresh session required");
    const result = await options.database.query<UserRow & { session_id: string }>(
      "SELECT u.id, u.email, u.password_hash, u.created_at, s.id AS session_id FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW() AND s.revoked_at IS NULL AND u.disabled_at IS NULL",
      [digest(presented)],
    );
    const user = result.rows[0];
    if (!user) return authError(reply, 401, "Refresh session expired");
    await options.database.query("UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1", [user.session_id]);
    await setRefreshCookie(reply, options.database, user.id);
    return { user: { id: user.id, email: user.email }, accessToken: await signAccessToken(options, user) };
  });

  server.get("/auth/me", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return authError(reply, 401, "Authentication required");
    try {
      const { payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(options.secret), { ...(options.issuer ? { issuer: options.issuer } : {}), ...(options.audience ? { audience: options.audience } : {}) });
      if (typeof payload.sub !== "string") return authError(reply, 401, "Invalid access token");
      const result = await options.database.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE id = $1 AND disabled_at IS NULL", [payload.sub]);
      const user = result.rows[0];
      if (!user) return authError(reply, 401, "Account not found");
      return { user };
    } catch { return authError(reply, 401, "Invalid access token"); }
  });

  server.post("/auth/logout", async (request, reply) => {
    const presented = readCookie(request.headers.cookie, REFRESH_COOKIE);
    if (presented) await options.database.query("UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = $1", [digest(presented)]);
    return reply.header("set-cookie", clearCookie()).send({ ok: true });
  });
}

async function signAccessToken(options: AuthOptions, user: { id: string; email: string }): Promise<string> {
  let builder = new SignJWT({ email: user.email }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(user.id).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS);
  if (options.issuer) builder = builder.setIssuer(options.issuer);
  if (options.audience) builder = builder.setAudience(options.audience);
  return builder.sign(new TextEncoder().encode(options.secret));
}
async function setRefreshCookie(reply: FastifyReply, database: Database, userId: string): Promise<void> {
  const token = randomBytes(48).toString("base64url");
  await database.query("INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')", [randomUUID(), userId, digest(token)]);
  reply.header("set-cookie", cookie(token));
}
function cookie(value: string): string { return REFRESH_COOKIE + "=" + encodeURIComponent(value) + "; Path=/api/auth; Max-Age=" + REFRESH_TTL_SECONDS + "; HttpOnly; Secure; SameSite=Lax"; }
function clearCookie(): string { return REFRESH_COOKIE + "=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax"; }
function readCookie(header: string | undefined, name: string): string | undefined { return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1).replace(/^"|"$/g, "").trim() || undefined; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1 });
  return "scrypt$16384$8$1$" + salt.toString("base64url") + "$" + hash.toString("base64url");
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltEncoded, hashEncoded] = parts;
  try {
    const expected = Buffer.from(hashEncoded!, "base64url");
    const actual = await scrypt(password, Buffer.from(saltEncoded!, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}
function normalizeEmail(value: unknown): string | undefined { if (typeof value !== "string") return undefined; const email = value.trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined; }
function validPassword(value: unknown): string | undefined { return typeof value === "string" && value.length >= 10 ? value : undefined; }
function isUniqueViolation(error: unknown): error is { code: string } { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505"; }
function authError(reply: FastifyReply, status: number, message: string) { return reply.code(status).send({ error: { code: status === 401 ? "unauthorized" : status === 403 ? "registration_closed" : "auth_error", message } }); }
export function parseAllowedEmails(value: string | undefined, production: boolean): string[] | "*" {
  if (value === undefined || value.trim() === "") return production ? [] : "*";
  if (value.trim() === "*") return "*";
  return value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}
