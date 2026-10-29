import { createHash, randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { FastifyRequest } from "fastify";
import { createDatabase, createPool, PostgresAssetRepository, PostgresProjectMemberRepository, PostgresProjectRepository, PostgresProposalStore, PostgresSceneRepository, PostgresRevisionRepository, PostgresTranscriptStore, PostgresRenderJobRepository, PostgresFeedbackRepository, PostgresPreferenceRepository, PostgresAuditRepository, type Database } from "@videocraft/persistence";
import { BullMqMediaQueue, BullMqRenderQueue, CloudflareMediaQueue, CloudflareQueueRenderQueue, type MediaQueuePort } from "@videocraft/jobs";
import { ProjectService } from "@videocraft/application";
import { FasterWhisperWorker } from "@videocraft/transcription";
import { LocalObjectStorage, S3ObjectStorage, type ObjectStorage } from "@videocraft/storage";
import { HighlightReelStrategy, OpenAiCompatibleReranker, ShortFormExplainerStrategy, StaticStrategyRegistry } from "@videocraft/strategies";
import { PySceneDetectWorker } from "@videocraft/scene-detection";
import { OpenAiCompatibleIntentAnalyzer, RuleBasedIntentAnalyzer } from "@videocraft/intent-analysis";
import { ClamAvScanner, EnvironmentSecretProvider, loadSecretEnvironment, RedisProviderQuota, requireSecret, type MalwareScanner } from "@videocraft/security";
import { configureTracing, MetricsRegistry } from "@videocraft/observability";
import { buildServer } from "./server.js";
import { registerUploadRoutes } from "./uploads.js";
import { createProxy, isStillImage, probeMedia } from "@videocraft/analysis";
import { StorageSilenceDetector } from "./media-analysis.js";
import { registerRenderRoutes } from "./render-routes.js";
import { registerMediaRoutes } from "./media-routes.js";
import { registerStockRoutes } from "./stock.js";
import { registerVoiceoverRoutes } from "./voiceover.js";
import { registerPreferenceRoutes } from "./learning.js";
import { registerMusicRoutes } from "./music-routes.js";
import { registerDirectorRoutes } from "./director-routes.js";
import { OpenAiDirector, RuleDirector } from "@videocraft/director";
import { registerIntentRoutes } from "./intent-routes.js";
import { registerFeedbackRoutes } from "./feedback-routes.js";
import { registerTimelineRoutes } from "./timeline-routes.js";
import { JwtAuthenticator, PostgresProjectAuthorizer } from "./auth.js";
import { validateProductionConfiguration } from "./config.js";
import { parseAllowedEmails, registerAuthRoutes } from "./auth-routes.js";

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
const rateLimitRedis = new Redis(redisOptions);
const providerQuota = new RedisProviderQuota(rateLimitRedis);
const transcriber = new FasterWhisperWorker({
  workerPath: required("WHISPER_WORKER_PATH"),
  mediaRoot,
  storage,
  ...(secretEnvironment.WHISPER_PYTHON ? { pythonCommand: secretEnvironment.WHISPER_PYTHON } : {}),
  ...(secretEnvironment.WHISPER_LANGUAGE ? { language: secretEnvironment.WHISPER_LANGUAGE } : {}),
});

const jwtSecrets = [
  requiredSecret("AUTH_JWT_SECRET"),
  ...(secretEnvironment.AUTH_JWT_SECRET_PREVIOUS ? [requiredSecret("AUTH_JWT_SECRET_PREVIOUS")] : []),
];
const authenticator = new JwtAuthenticator(jwtSecrets, {
  ...(secretEnvironment.AUTH_ISSUER ? { issuer: secretEnvironment.AUTH_ISSUER } : {}),
  ...(secretEnvironment.AUTH_AUDIENCE ? { audience: secretEnvironment.AUTH_AUDIENCE } : {}),
});
const authorizer = new PostgresProjectAuthorizer(projects, db);
const revisions = new PostgresRevisionRepository(db);
const renderJobs = new PostgresRenderJobRepository(db);
const queueProvider = secretEnvironment.JOB_QUEUE_PROVIDER ?? "bullmq";
const cloudflareQueue = queueProvider === "cloudflare"
  ? new CloudflareQueueRenderQueue({ accountId: required("CF_ACCOUNT_ID"), queueId: required("CF_QUEUE_ID"), apiToken: requiredSecret("CF_QUEUES_API_TOKEN") }, assets, renderJobs)
  : undefined;
const bullmqQueue = queueProvider === "bullmq" ? new Queue("videocraft-render", { connection: redisOptions }) : undefined;
const renderQueue = cloudflareQueue ?? bullmqQueue!;
// Preview proxies go to the worker (MEDIA_JOBS=inline keeps them in the API process, e.g. for local development).
const bullmqMediaQueue = queueProvider === "bullmq" && secretEnvironment.MEDIA_JOBS !== "inline" ? new Queue("videocraft-media", { connection: redisOptions }) : undefined;
const mediaQueue: MediaQueuePort | undefined = secretEnvironment.MEDIA_JOBS === "inline" ? undefined
  : queueProvider === "cloudflare" ? new CloudflareMediaQueue({ accountId: required("CF_ACCOUNT_ID"), queueId: required("CF_QUEUE_ID"), apiToken: requiredSecret("CF_QUEUES_API_TOKEN") })
  : bullmqMediaQueue ? new BullMqMediaQueue(bullmqMediaQueue as never) : undefined;
const timelineService = new ProjectService(projects, assets, revisions, { next: () => randomUUID() }, { now: () => new Date().toISOString() });
const transcripts = new PostgresTranscriptStore(db);
const feedback = new PostgresFeedbackRepository(db);
const preferences = new PostgresPreferenceRepository(db);
const audit = new PostgresAuditRepository(db);
const intentProviderMode = secretEnvironment.INTENT_PROVIDER_MODE ?? (secretEnvironment.INTENT_PROVIDER_API_KEY ? "external" : "rule-based");
const intentAnalyzer = intentProviderMode === "external"
  ? new OpenAiCompatibleIntentAnalyzer({ endpoint: required("INTENT_PROVIDER_URL"), apiKey: required("INTENT_PROVIDER_API_KEY"), model: required("INTENT_PROVIDER_MODEL") })
  : new RuleBasedIntentAnalyzer();
const server = buildServer({
  projects, assets, members, storage, revisions, ...(secretEnvironment.METRICS_AUTH_TOKEN ? { metricsToken: secretEnvironment.METRICS_AUTH_TOKEN } : {}),
  ...(sceneDetector ? { sceneDetector } : {}),
  preferences,
  silenceDetector: new StorageSilenceDetector(storage, secretEnvironment.FFMPEG_BIN ? { ffmpeg: secretEnvironment.FFMPEG_BIN } : {}),
  scenes,
  transcripts,
  proposals: new PostgresProposalStore(db),
  strategies: new StaticStrategyRegistry([new ShortFormExplainerStrategy(), new HighlightReelStrategy(secretEnvironment.HIGHLIGHT_RERANK_MODE === "external" ? {
    reranker: new OpenAiCompatibleReranker({
      endpoint: secretEnvironment.HIGHLIGHT_RERANK_URL ?? required("INTENT_PROVIDER_URL"),
      apiKey: secretEnvironment.HIGHLIGHT_RERANK_API_KEY ?? required("INTENT_PROVIDER_API_KEY"),
      model: secretEnvironment.HIGHLIGHT_RERANK_MODEL ?? required("INTENT_PROVIDER_MODEL"),
      maxPerMinute: boundedInteger("HIGHLIGHT_RERANK_MAX_PER_MINUTE", 30, 1, 1_000),
    }),
  } : {})]),
  transcriber,
  renderer: cloudflareQueue ?? new BullMqRenderQueue(bullmqQueue!, assets, renderJobs),
  authenticate: authenticator,
  authorize: authorizer,
  audit,
  metrics,
  readiness: [
    { name: "database", check: async () => { await db.query("SELECT 1"); return true; } },
    { name: "redis", check: async () => { await renderQueue.getJobCounts(); return true; } },
  ],
});
await server.register(rateLimit, { max: 120, timeWindow: "1 minute", redis: rateLimitRedis, skipOnError: false, keyGenerator: rateLimitKey });
registerAuthRoutes(server, {
  database: db,
  secret: requiredSecret("AUTH_JWT_SECRET"),
  allowedEmails: parseAllowedEmails(secretEnvironment.AUTH_ALLOWED_EMAILS, secretEnvironment.NODE_ENV === "production"),
  ...(secretEnvironment.AUTH_ISSUER ? { issuer: secretEnvironment.AUTH_ISSUER } : {}),
  ...(secretEnvironment.AUTH_AUDIENCE ? { audience: secretEnvironment.AUTH_AUDIENCE } : {}),
});
registerTimelineRoutes(server, { projects, revisions, preferences, assets, authenticate: (request) => authenticator.authenticate(request), authorize: authorizer, saveRevision: (input) => timelineService.saveRevision(input) });
registerFeedbackRoutes(server, { feedback, revisions, proposals: new PostgresProposalStore(db), authenticate: (request) => authenticator.authenticate(request), authorize: authorizer, now: () => new Date().toISOString() });
registerIntentRoutes(server, { analyzer: intentAnalyzer, assets, transcripts, quota: providerQuota, providerRateLimitMax: boundedInteger("INTENT_PROVIDER_MAX_PER_MINUTE", 20, 1, 1_000), authenticate: (request) => authenticator.authenticate(request), authorize: authorizer });
registerRenderRoutes(server, { jobs: renderJobs, storage, signingSecret: requiredSecret("DOWNLOAD_SIGNING_SECRET"), authenticate: (request) => authenticator.authenticate(request), authorize: authorizer });
registerPreferenceRoutes(server, { preferences, authenticate: (request) => authenticator.authenticate(request) });
// The AI director uses OpenAI (vision + structured output) when a key is set; built-in rules otherwise.
const director = secretEnvironment.OPENAI_API_KEY && secretEnvironment.DIRECTOR_MODE !== "rules"
  ? new OpenAiDirector({ apiKey: secretEnvironment.OPENAI_API_KEY, model: secretEnvironment.DIRECTOR_MODEL ?? "gpt-6.1-sol", ...(secretEnvironment.OPENAI_BASE_URL ? { endpoint: secretEnvironment.OPENAI_BASE_URL } : {}) })
  : new RuleDirector();
registerDirectorRoutes(server, { projects, assets, revisions, storage, transcripts, director, saveRevision: (input) => timelineService.saveRevision(input), authenticate: (request) => authenticator.authenticate(request), authorize: authorizer, clock: () => new Date().toISOString(), ...(secretEnvironment.FFMPEG_BIN ? { ffmpeg: secretEnvironment.FFMPEG_BIN } : {}) });
registerMusicRoutes(server, { assets, revisions, storage, authenticate: (request) => authenticator.authenticate(request), authorize: authorizer, clock: () => new Date().toISOString() });
registerMediaRoutes(server, { assets, storage, signingSecret: requiredSecret("DOWNLOAD_SIGNING_SECRET"), authenticate: (request) => authenticator.authenticate(request), authorize: authorizer,
  ...(secretEnvironment.FACES_SCRIPT ? { faces: { script: secretEnvironment.FACES_SCRIPT, ...(secretEnvironment.SCENE_PYTHON ? { executable: secretEnvironment.SCENE_PYTHON } : {}) } } : {}),
  ...(secretEnvironment.MATTE_SCRIPT ? { matte: { script: secretEnvironment.MATTE_SCRIPT, ...(secretEnvironment.SCENE_PYTHON ? { executable: secretEnvironment.SCENE_PYTHON } : {}) } } : {}) });
// Voice-over from typed text (OpenAI voices, the account's key); recordings use the ordinary upload.
registerVoiceoverRoutes(server, {
  ...(secretEnvironment.OPENAI_API_KEY ? { apiKey: secretEnvironment.OPENAI_API_KEY } : {}), ...(secretEnvironment.OPENAI_BASE_URL ? { endpoint: secretEnvironment.OPENAI_BASE_URL } : {}), ...(secretEnvironment.VOICE_MODEL ? { model: secretEnvironment.VOICE_MODEL } : {}),
  assets, storage, authorize: authorizer, authenticate: (request) => authenticator.authenticate(request), clock: () => new Date().toISOString(),
  inspector: (path) => probeMedia(path, secretEnvironment.FFPROBE_BIN ? { executable: secretEnvironment.FFPROBE_BIN } : {}),
});
// Free stock videos, photos and GIFs for cutaways (each library is skipped when its key is not set).
registerStockRoutes(server, {
  keys: { ...(secretEnvironment.PEXELS_API_KEY ? { pexels: secretEnvironment.PEXELS_API_KEY } : {}), ...(secretEnvironment.PIXABAY_API_KEY ? { pixabay: secretEnvironment.PIXABAY_API_KEY } : {}), ...(secretEnvironment.GIPHY_API_KEY ? { giphy: secretEnvironment.GIPHY_API_KEY } : {}) },
  assets, storage, authorize: authorizer, authenticate: (request) => authenticator.authenticate(request), clock: () => new Date().toISOString(),
  inspector: (path) => probeMedia(path, secretEnvironment.FFPROBE_BIN ? { executable: secretEnvironment.FFPROBE_BIN } : {}),
  imageInspector: (path) => isStillImage(path, secretEnvironment.FFPROBE_BIN ? { executable: secretEnvironment.FFPROBE_BIN } : {}),
});
registerUploadRoutes(server, {
  assets, storage, authorize: authorizer, authenticate: (request) => authenticator.authenticate(request),
  clock: () => new Date().toISOString(), ...(malwareScanner ? { scanner: malwareScanner } : {}),
  inspector: (path) => probeMedia(path, secretEnvironment.FFPROBE_BIN ? { executable: secretEnvironment.FFPROBE_BIN } : {}),
  imageInspector: (path) => isStillImage(path, secretEnvironment.FFPROBE_BIN ? { executable: secretEnvironment.FFPROBE_BIN } : {}),
  // Preview proxies for formats browsers cannot play (PREVIEW_PROXIES=false disables).
  ...(secretEnvironment.PREVIEW_PROXIES === "false" ? {} : { proxy: (input: string, output: string) => createProxy(input, output, secretEnvironment.FFMPEG_BIN ? { executable: secretEnvironment.FFMPEG_BIN } : {}) }),
  ...(mediaQueue ? { proxyQueue: mediaQueue } : {}),
  onBackgroundDone: (assetId, outcome, caught) => { if (outcome === "failed") server.log.warn({ assetId, err: caught }, "Preview proxy failed"); },
});

const port = Number(secretEnvironment.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
const shutdown = async () => { await server.close(); await renderQueue.close(); await bullmqMediaQueue?.close(); await rateLimitRedis.quit(); await tracing.shutdown(); await pool.end(); };
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
await server.listen({ host: "0.0.0.0", port });
