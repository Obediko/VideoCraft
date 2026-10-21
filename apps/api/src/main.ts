import { Queue } from "bullmq";
import { createPool, PostgresAssetRepository, PostgresProjectRepository, PostgresProposalStore, PostgresRevisionRepository, PostgresTranscriptStore, type Database } from "@videocraft/persistence";
import { BullMqRenderQueue } from "@videocraft/jobs";
import { FasterWhisperWorker } from "@videocraft/transcription";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { buildServer } from "./server.js";
import { JwtAuthenticator, PostgresProjectAuthorizer } from "./auth.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
}
function redisConnection(value: string) {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL must use redis:// or rediss://");
  return { host: url.hostname, port: Number(url.port || "6379"), ...(url.username ? { username: decodeURIComponent(url.username) } : {}), ...(url.password ? { password: decodeURIComponent(url.password) } : {}), ...(url.protocol === "rediss:" ? { tls: {} } : {}) };
}

const pool = createPool(required("DATABASE_URL"));
const db = pool as unknown as Database;
const projects = new PostgresProjectRepository(db);
const assets = new PostgresAssetRepository(db);
const renderQueue = new Queue("videocraft-render", { connection: redisConnection(required("REDIS_URL")) });
const transcriber = new FasterWhisperWorker({
  workerPath: required("WHISPER_WORKER_PATH"),
  mediaRoot: required("MEDIA_ROOT"),
  ...(process.env.WHISPER_PYTHON ? { pythonCommand: process.env.WHISPER_PYTHON } : {}),
  ...(process.env.WHISPER_LANGUAGE ? { language: process.env.WHISPER_LANGUAGE } : {}),
});

const server = buildServer({
  projects, assets, revisions: new PostgresRevisionRepository(db),
  transcripts: new PostgresTranscriptStore(db),
  proposals: new PostgresProposalStore(db),
  strategies: new StaticStrategyRegistry(),
  transcriber,
  renderer: new BullMqRenderQueue(renderQueue, assets),
  authenticate: new JwtAuthenticator(required("AUTH_JWT_SECRET"), {
    ...(process.env.AUTH_ISSUER ? { issuer: process.env.AUTH_ISSUER } : {}),
    ...(process.env.AUTH_AUDIENCE ? { audience: process.env.AUTH_AUDIENCE } : {}),
  }),
  authorize: new PostgresProjectAuthorizer(projects, db),
});

const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
const shutdown = async () => { await server.close(); await renderQueue.close(); await pool.end(); };
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
await server.listen({ host: "0.0.0.0", port });
