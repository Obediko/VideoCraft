import { createHash, randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { FastifyRequest } from "fastify";
import { createDatabase, createPool, PostgresAssetRepository, PostgresProjectMemberRepository, PostgresProjectRepository, PostgresProposalStore, PostgresSceneRepository, PostgresRevisionRepository, PostgresTranscriptStore, PostgresRenderJobRepository, PostgresFeedbackRepository, PostgresAuditRepository, type Database } from "@videocraft/persistence";
import { BullMqRenderQueue } from "@videocraft/jobs";
import { ProjectService } from "@videocraft/application";
import { FasterWhisperWorker } from "@videocraft/transcription";
import { LocalObjectStorage, S3ObjectStorage, type ObjectStorage } from "@videocraft/storage";
import { StaticStrategyRegistry } from "@videocraft/strategies";
import { PySceneDetectWorker } from "@videocraft/scene-detection";
import { OpenAiCompatibleIntentAnalyzer, RuleBasedIntentAnalyzer } from "@videocraft/intent-analysis";
import { ClamAvScanner, EnvironmentSecretProvider, loadSecretEnvironment, RedisProviderQuota, requireSecret, type MalwareScanner } from "@videocraft/security";
import { configureTracing, MetricsRegistry } from "@videocraft/observability";
import { buildServer } from "./server.js";
import { registerUploadRoutes } from "./uploads.js";
import { registerRenderRoutes } from "./render-routes.js";
import { registerIntentRoutes } from "./intent-routes.js";
import { registerFeedbackRoutes } from "./feedback-routes.js";
import { registerTimelineRoutes } from "./timeline-routes.js";
import { JwtAuthenticator, PostgresProjectAuthorizer } from "./auth.js";
import { validateProductionConfiguration } from "./config.js";

const secretEnvironment = await loadSecretEnvironment(process.env);
const secrets = new EnvironmentSecretProvider(secretEnvironment);
function required(name: string): string { return requireSecret(secrets, name); }
function requiredSecret(name: string): string { return requireSecret(secrets, name, 32); }
function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = secretEnvironment[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(name + " must be an integer between " + minimum + " and " + maximum);
  }
  return parsed;
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
  return { host: url.hostname, port: Number(url.port || "6379"), connectTimeout: boundedInteger("REDIS_CONNECT_TIMEOUT_MS", 5_000, 100, 60_000), ...(url.username ? { username: decodeURIComponent(url.username) } : {}), ...(url.password ? { password: decodeURIComponent(url.password) } : {}), ...(url.protocol === "rediss:" ? { tls: {} } : {}) };
}
function createStorage(): ObjectStorage {
  if ((secretEnvironment.OBJECT_STORAGE_PROVIDER ?? "local") === "s3") {
    return new S3ObjectStorage({
      bucket: required("S3_BUCKET"),
      region: secretEnvironment.S3_REGION ?? "us-east-1",
      ...(secretEnvironment.S3_ENDPOINT ? { endpoint: secretEnvironment.S3_ENDPOINT } : {}),
      ...(secretEnvironment.S3_PUBLIC_URL ? { publicUrl: secretEnvironment.S3_PUBLIC_URL } : {}),
      forcePathStyle: secretEnvironment.S3_FORCE_PATH_STYLE === "true",
    });
  }
  return new LocalObjectStorage(required("MEDIA_ROOT"));
}
function createMalwareScanner(): MalwareScanner | undefined {
  const host = secretEnvironment.CLAMAV_HOST;
  if (!host && secretEnvironment.MALWARE_SCAN_REQUIRED === "true") throw new Error("CLAMAV_HOST is required when MALWARE_SCAN_REQUIRED=true");
  return host ? new ClamAvScanner({ host, port: Number(secretEnvironment.CLAMAV_PORT ?? "3310") }) : undefined;
}

validateProductionConfiguration(secretEnvironment);
const tracing = configureTracing(secretEnvironment);
const pool = createPool({
  connectionString: required("DATABASE_URL"),
  max: boundedInteger("DB_POOL_MAX", 20, 1, 100),
  connectionTimeoutMillis: boundedInteger("DB_CONNECTION_TIMEOUT_MS", 5_000, 100, 60_000),
  idleTimeoutMillis: boundedInteger("DB_IDLE_TIMEOUT_MS", 30_000, 1_000, 300_000),
});
const db: Database = createDatabase(pool);
const projects = new PostgresProjectRepository(db);
const assets = new PostgresAssetRepository(db);
const members = new PostgresProjectMemberRepository(db);
const scenes = new PostgresSceneRepository(db);
const mediaRoot = required("MEDIA_ROOT");
const storage = createStorage();
const malwareScanner = createMalwareScanner();
const sceneDetector = secretEnvironment.SCENE_WORKER_PATH ? new PySceneDetectWorker({ workerPath: secretEnvironment.SCENE_WORKER_PATH, storage, ...(secretEnvironment.SCENE_PYTHON ? { pythonCommand: secretEnvironment.SCENE_PYTHON } : {}) }) : undefined;
const metrics = new MetricsRegistry();
const redisOptions = redisConnection(required("REDIS_URL"));
const renderQueue = new Queue("videocraft-render", { connection: redisOptions });
const rateLimitRedis = new Redis(redisOptions);
const providerQuota = new RedisProviderQuota(rateLimitRedis);
const transcriber = new FasterWhisperWorker({
  workerPath: required("WHISPER_WORKER_PATH"),
  mediaRoot,
  storage,
  ...(secretEnvironment.WHISPER_PYTHON ? { pythonCommand: secretEnvironment.WHISPER_PYTHON } : {}),
  ...(secretEnvironment.WHISPER_LANGUAGE ? { language: secretEnvironment.WHISPER_LANGUAGE } : {}),
});

const authenticator = new JwtAuthenticator(requiredSecret("AUTH_JWT_SECRET"), {
  ...(secretEnvironment.AUTH_ISSUER ? { issuer: secretEnvironment.AUTH_ISSUER } : {}),
  ...(secretEnvironment.AUTH_AUDIENCE ? { audience: secretEnvironment.AUTH_AUDIENCE } : {}),
});
const authorizer = new PostgresProjectAuthorizer(projects, db);
const revisions = new PostgresRevisionRepository(db);
const renderJobs = new PostgresRenderJobRepository(db);
const timelineService = new ProjectService(projects, assets, revisions, { next: () => randomUUID() }, { now: () => new Date().toISOString() });
const transcripts = new PostgresTranscriptStore(db);
const feedback = new PostgresFeedbackRepository(db);
const audit = new PostgresAuditRepository(db);
const intentAnalyzer = secretEnvironment.INTENT_PROVIDER_API_KEY
  ? new OpenAiCompatibleIntentAnalyzer({ endpoint: secretEnvironment.INTENT_PROVIDER_URL ?? "https://api.openai.com/v1", apiKey: secretEnvironment.INTENT_PROVIDER_API_KEY, model: secretEnvironment.INTENT_PROVIDER_MODEL ?? "gpt-4o-mini" })
  : new RuleBasedIntentAnalyzer();
const server = buildServer({
  projects, assets, members, storage, revisions,
  ...(sceneDetector ? { sceneDetector } : {}),
  scenes,
  transcripts,
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
server.register(rateLimit, { max: 120, timeWindow: "1 minute", redis: rateLimitRedis, skipOnError: false, keyGenerator: rateLimitKey });
registerTimelineRoutes(server, { projects, revisions, authenticate: (request) => authenticator.authenticate(request), authorize: authorizer, saveRevision: (input) => timelineService.saveRevision(input) });
registerFeedbackRoutes(server, { feedback, revisions, proposals: new PostgresProposalStore(db), authenticate: (request) => authenticator.authenticate(request), authorize: authorizer, now: () => new Date().toISOString() });
registerIntentRoutes(server, { analyzer: intentAnalyzer, assets, transcripts, quota: providerQuota, providerRateLimitMax: boundedInteger("INTENT_PROVIDER_MAX_PER_MINUTE", 20, 1, 1_000), authenticate: (request) => authenticator.authenticate(request), authorize: authorizer });
registerRenderRoutes(server, { jobs: renderJobs, storage, signingSecret: requiredSecret("DOWNLOAD_SIGNING_SECRET"), authenticate: (request) => authenticator.authenticate(request), authorize: authorizer });
registerUploadRoutes(server, {
  assets, storage, authorize: authorizer, authenticate: (request) => authenticator.authenticate(request),
  clock: () => new Date().toISOString(), ...(malwareScanner ? { scanner: malwareScanner } : {}),
});

const port = Number(secretEnvironment.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
const shutdown = async () => { await server.close(); await renderQueue.close(); await rateLimitRedis.quit(); await tracing.shutdown(); await pool.end(); };
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
await server.listen({ host: "0.0.0.0", port });
