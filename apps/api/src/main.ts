import { createPool, PostgresAssetRepository, PostgresProjectRepository, PostgresRevisionRepository, type Database } from "@videocraft/persistence";
import { buildServer } from "./server.js";
import { JwtAuthenticator, PostgresProjectAuthorizer } from "./auth.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
}

const databaseUrl = required("DATABASE_URL");
const jwtSecret = required("AUTH_JWT_SECRET");
const pool = createPool(databaseUrl);
const db = pool as unknown as Database;
const projects = new PostgresProjectRepository(db);

const server = buildServer({
  projects,
  assets: new PostgresAssetRepository(db),
  revisions: new PostgresRevisionRepository(db),
  authenticate: new JwtAuthenticator(jwtSecret, {
    ...(process.env.AUTH_ISSUER ? { issuer: process.env.AUTH_ISSUER } : {}),
    ...(process.env.AUTH_AUDIENCE ? { audience: process.env.AUTH_AUDIENCE } : {}),
  }),
  authorize: new PostgresProjectAuthorizer(projects, db),
});

const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");

const shutdown = async () => {
  await server.close();
  await pool.end();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await server.listen({ host: "0.0.0.0", port });
