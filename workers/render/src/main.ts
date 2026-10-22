import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { Worker, type Job } from "bullmq";
import { PostgresRenderJobRepository, createPool, type Database } from "@videocraft/persistence";
import { safeMediaPath } from "@videocraft/transcription";
import { FfmpegCommandPlanner, FfmpegProcess } from "@videocraft/rendering";
import { LocalObjectStorage, S3ObjectStorage, type ObjectStorage } from "@videocraft/storage";
import type { RenderTask } from "@videocraft/jobs";
import type { RenderJob } from "@videocraft/domain";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required");
  return value;
}
function redisConnection(value: string) {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL must use redis:// or rediss://");
  return {
    host: url.hostname,
    port: Number(url.port || "6379"),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}
function outputExtension(format: RenderTask["settings"]["format"]): string {
  return format === "webm" ? "webm" : "mp4";
}
function createStorage(): ObjectStorage {
  if ((process.env.OBJECT_STORAGE_PROVIDER ?? "local") === "s3") {
    return new S3ObjectStorage({
      bucket: required("S3_BUCKET"),
      region: process.env.S3_REGION ?? "us-east-1",
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      ...(process.env.S3_FORCE_PATH_STYLE === undefined ? {} : { forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" }),
      ...(process.env.S3_PUBLIC_URL ? { publicUrl: process.env.S3_PUBLIC_URL } : {}),
    });
  }
  return new LocalObjectStorage(required("MEDIA_ROOT"));
}
function safeRunPath(root: string, jobId: string, name: string): string {
  return safeMediaPath(root, "runs/" + jobId + "/" + name);
}
async function stageInputs(storage: ObjectStorage, root: string, job: RenderTask): Promise<Record<string, string>> {
  if (!storage.downloadToFile) throw new Error("Configured storage provider cannot stage media for rendering");
  const staged: Record<string, string> = {};
  for (const [assetId, storageKey] of Object.entries(job.assetStorageKeys)) {
    const destination = safeRunPath(root, job.jobId, "inputs/" + createHash("sha256").update(storageKey).digest("hex"));
    await mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
    await storage.downloadToFile(storageKey, destination);
    staged[assetId] = destination;
  }
  return staged;
}

const outputRoot = process.env.RENDER_WORK_ROOT ?? required("RENDER_ROOT");
const storage = createStorage();
await mkdir(outputRoot, { recursive: true });
const pool = createPool(required("DATABASE_URL"));
const renderJobs = new PostgresRenderJobRepository(pool as unknown as Database);
const processRunner = new FfmpegProcess(process.env.FFMPEG_BIN ?? "ffmpeg");
const worker = new Worker<RenderTask>("videocraft-render", async (job: Job<RenderTask>) => {
  const jobId = String(job.id ?? job.data.jobId);
  const { errorMessage: _previousError, ...baseWithoutError } = await (async () => {
    const record = await renderJobs.get(jobId);
    const base: RenderJob = record ?? {
      id: jobId,
      projectId: job.data.project.id,
      revision: job.data.revision.revision,
      settings: job.data.settings,
      idempotencyKey: job.data.idempotencyKey,
      status: "queued",
      progress: 0,
    };
    if (!record) await renderJobs.save(base);
    return base;
  })();
  if (baseWithoutError.status === "cancelled") return baseWithoutError;

  const running = { ...baseWithoutError, status: "running" as const, progress: 5 };
  await renderJobs.update(running);
  const runRoot = safeMediaPath(outputRoot, "runs/" + jobId);
  await mkdir(runRoot, { recursive: true });
  try {
    const stagedAssets = await stageInputs(storage, outputRoot, job.data);
    const outputKey = "projects/" + job.data.project.id + "/renders/" + jobId + "." + outputExtension(job.data.settings.format);
    const outputPath = safeRunPath(outputRoot, jobId, "output." + outputExtension(job.data.settings.format));
    const assetResolver = { resolve: async (assetId: string) => {
      const path = stagedAssets[assetId];
      if (!path) throw new Error("Asset is missing from render manifest");
      return path;
    }};
    const plan = await new FfmpegCommandPlanner(assetResolver).plan(job.data.revision, job.data.settings, outputPath);
    await job.updateProgress(25);
    await renderJobs.update({ ...running, progress: 25 });

    const controller = new AbortController();
    const cancellationWatcher = setInterval(() => {
      void renderJobs.get(jobId).then((latest) => {
        if (latest?.status === "cancelled") controller.abort();
      }).catch(() => undefined);
    }, 1000);
    try {
      await processRunner.run(plan, controller.signal);
    } finally {
      clearInterval(cancellationWatcher);
    }

    const stored = await storage.putFile(outputPath, outputKey);
    const succeeded: RenderJob = {
      ...running,
      status: "succeeded",
      progress: 100,
      output: {
        storageKey: stored.key,
        checksumSha256: stored.checksumSha256,
        sizeBytes: stored.size,
        mimeType: job.data.settings.format === "webm" ? "video/webm" : "video/mp4",
      },
    };
    await renderJobs.update(succeeded);
    await job.updateProgress(100);
    return succeeded;
  } catch (error) {
    const latest = await renderJobs.get(jobId);
    if (latest?.status === "cancelled") return latest;
    const failed: RenderJob = {
      ...running,
      status: "failed",
      progress: running.progress,
      errorMessage: error instanceof Error ? error.message : "Render failed",
    };
    await renderJobs.update(failed);
    throw error;
  } finally {
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}, { connection: redisConnection(required("REDIS_URL")), concurrency: Number(process.env.RENDER_CONCURRENCY ?? "1") });

worker.on("completed", (job) => console.log(JSON.stringify({ event: "render.completed", jobId: job.id })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "render.failed", jobId: job?.id, error: error.message })));
worker.on("error", (error) => console.error(JSON.stringify({ event: "render.worker_error", error: error.message })));
const shutdown = async () => { await worker.close(); await pool.end(); };
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
