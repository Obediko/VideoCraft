import { createHash, randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { Queue } from "bullmq";
import type { FastifyRequest } from "fastify";
import { createPool, PostgresAssetRepository, PostgresProjectRepository, PostgresProposalStore, PostgresRevisionRepository, PostgresTranscriptStore, PostgresRenderJobRepository, PostgresFeedbackRepository, PostgresAuditRepository, type Database } from "@videocraft/persistence";
import { BullMqRenderQueue } from "@videocraft/jobs";
import { ProjectService } from "@videocraft/application";
import { FasterWhisperWorker } from "@videocraft/transcription";
import { LocalObjectStorage, S3ObjectStorage, type ObjectStorage } from "@videocraft/storage";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { OpenAiCompatibleIntentAnalyzer, RuleBasedIntentAnalyzer } from "@videocraft/intent-analysis";
import { ClamAvScanner, type MalwareScanner } from "@videocraft/security";
import { MetricsRegistry } from "@videocraft/observability";
import { buildServer } from "./server.js";
import { registerUploadRoutes } from "./uploads.js";
import { registerRenderRoutes } from "./render-routes.js";
import { registerIntentRoutes } from "./intent-routes.js";
import { registerFeedbackRoutes } from "./feedback-routes.js";
import { registerTimelineRoutes } from "./timeline-routes.js";
import { JwtAuthenticator, PostgresProjectAuthorizer } from "./auth.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
}
function rateLimitKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ")
    ? "principal:" + createHash("sha256").update(authorization).digest("hex")
    : "ip:" + request.ip;
}
function redisConnection(value: string) {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL must use redis:// or rediss://");
  return { host: url.hostname, port: Number(url.port || "6379"), ...(url.username ? { username: decodeURIComponent(url.username) } : {}), ...(url.password ? { password: decodeURIComponent(url.password) } : {}), ...(url.protocol === "rediss:" ? { tls: {} } : {}) };
}
function createStorage(): ObjectStorage {
  if ((process.env.OBJECT_STORAGE_PROVIDER ?? "local") === "s3") {
    return new S3ObjectStorage({
      bucket: required("S3_BUCKET"),
      region: process.env.S3_REGION ?? "us-east-1",
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      ...(process.env.S3_PUBLIC_URL ? { publicUrl: process.env.S3_PUBLIC_URL } : {}),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    });
  }
  return new LocalObjectStorage(required("MEDIA_ROOT"));
}
function createMalwareScanner(): MalwareScanner | undefined {
  const host = process.env.CLAMAV_HOST;
  if (!host && process.env.MALWARE_SCAN_REQUIRED === "true") throw new Error("CLAMAV_HOST is required when MALWARE_SCAN_REQUIRED=true");
  return host ? new ClamAvScanner({ host, port: Number(process.env.CLAMAV_PORT ?? "3310") }) : undefined;
}

const pool = createPool(required("DATABASE_URL"));
const db = pool as unknown as Database;
const projects = new PostgresProjectRepository(db);
const assets = new PostgresAssetRepository(db);
const mediaRoot = required("MEDIA_ROOT");
const storage = createStorage();
const malwareScanner = createMalwareScanner();
const metrics = new MetricsRegistry();
const renderQueue = new Queue("videocraft-render", { connection: redisConnection(required("REDIS_URL")) });
const transcriber = new FasterWhisperWorker({
  workerPath: required("WHISPER_WORKER_PATH"),
  mediaRoot,
  ...(process.env.WHISPER_PYTHON ? { pythonCommand: process.env.WHISPER_PYTHON } : {}),
  ...(process.env.WHISPER_LANGUAGE ? { language: process.env.WHISPER_LANGUAGE } : {}),
});

const authenticator = new JwtAuthenticator(required("AUTH_JWT_SECRET"), {
  ...(process.env.AUTH_ISSUER ? { issuer: process.env.AUTH_ISSUER } : {}),
  ...(process.env.AUTH_AUDIENCE ? { audience: process.env.AUTH_AUDIENCE } : {}),
});
const authorizer = new PostgresProjectAuthorizer(projects, db);
const revisions = new PostgresRevisionRepository(db);
const renderJobs = new PostgresRenderJobRepository(db);
const timelineService = new ProjectService(projects, assets, revisions, { next: () => randomUUID() }, { now: () => new Date().toISOString() });
const feedback = new PostgresFeedbackRepository(db);
const audit = new PostgresAuditRepository(db);
const intentAnalyzer = process.env.INTENT_PROVIDER_API_KEY
  ? new OpenAiCompatibleIntentAnalyzer({ endpoint: process.env.INTENT_PROVIDER_URL ?? "https://api.openai.com/v1", apiKey: process.env.INTENT_PROVIDER_API_KEY, model: process.env.INTENT_PROVIDER_MODEL ?? "gpt-4o-mini" })
  : new RuleBasedIntentAnalyzer();
const server = buildServer({
  projects, assets, storage, revisions,
  transcripts: new PostgresTranscriptStore(db),
  proposals: new PostgresProposalStore(db),
  strategies: new StaticStrategyRegistry(),
  transcriber,
  renderer: new BullMqRenderQueue(renderQueue, assets, renderJobs),
  authenticate: authenticator,
  authorize: authorizer,
  audit,
  metrics,
  readiness: [
    { name: "database", check: async () => { await db.query("SELECT 1"); return true; } },
    { name: "redis", check: async () => { await renderQueue.getJobCounts(); return true; } },
  ],
});
server.register(rateLimit, { max: 120, timeWindow: "1 minute", skipOnError: true, keyGenerator: rateLimitKey });
registerTimelineRoutes(server, { projects, revisions, authenticate: (request) => authenticator.authenticate(request), authorize: authorizer, saveRevision: (input) => timelineService.saveRevision(input) });
registerFeedbackRoutes(server, { feedback, authenticate: (request) => authenticator.authenticate(request), authorize: authorizer, now: () => new Date().toISOString() });
registerIntentRoutes(server, { analyzer: intentAnalyzer, authenticate: (request) => authenticator.authenticate(request), authorize: authorizer });
registerRenderRoutes(server, { jobs: renderJobs, storage, signingSecret: required("DOWNLOAD_SIGNING_SECRET"), authenticate: (request) => authenticator.authenticate(request), authorize: authorizer });
registerUploadRoutes(server, {
  assets, storage, authorize: authorizer, authenticate: (request) => authenticator.authenticate(request),
  clock: () => new Date().toISOString(), ...(malwareScanner ? { scanner: malwareScanner } : {}),
});

const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
const shutdown = async () => { await server.close(); await renderQueue.close(); await pool.end(); };
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
await server.listen({ host: "0.0.0.0", port });
