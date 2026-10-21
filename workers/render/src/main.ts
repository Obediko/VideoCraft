import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Worker, type Job } from "bullmq";
import { PostgresRenderJobRepository, createPool, type Database } from "@videocraft/persistence";
import { safeMediaPath } from "@videocraft/transcription";
import { FfmpegCommandPlanner, FfmpegProcess } from "@videocraft/rendering";
import type { RenderTask } from "@videocraft/jobs";
import type { RenderJob } from "@videocraft/domain";

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(name + " is required"); return value; }
function redisConnection(value: string) {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL must use redis:// or rediss://");
  return { host: url.hostname, port: Number(url.port || "6379"), ...(url.username ? { username: decodeURIComponent(url.username) } : {}), ...(url.password ? { password: decodeURIComponent(url.password) } : {}), ...(url.protocol === "rediss:" ? { tls: {} } : {}) };
}
function outputExtension(format: RenderTask["settings"]["format"]): string { return format === "webm" ? "webm" : "mp4"; }
async function checksum(path: string): Promise<{ sizeBytes: number; checksumSha256: string }> {
  const digest = createHash("sha256");
  const input = createReadStream(path);
  await new Promise<void>((resolve, reject) => { input.on("data", (chunk) => digest.update(chunk)); input.on("error", reject); input.on("end", () => resolve()); });
  return { sizeBytes: (await stat(path)).size, checksumSha256: digest.digest("hex") };
}

const mediaRoot = required("MEDIA_ROOT");
const outputRoot = required("RENDER_ROOT");
await mkdir(outputRoot + "/renders", { recursive: true });
const pool = createPool(required("DATABASE_URL"));
const renderJobs = new PostgresRenderJobRepository(pool as unknown as Database);
const processRunner = new FfmpegProcess(process.env.FFMPEG_BIN ?? "ffmpeg");
const worker = new Worker<RenderTask>("videocraft-render", async (job: Job<RenderTask>) => {
  const jobId = String(job.id ?? job.data.jobId);
  let record = await renderJobs.get(jobId);
  const base: RenderJob = record ?? { id: jobId, projectId: job.data.project.id, revision: job.data.revision.revision, settings: job.data.settings, idempotencyKey: job.data.idempotencyKey, status: "queued", progress: 0 };
  if (!record) await renderJobs.save(base);
  if (base.status === "cancelled") return base;
  const { errorMessage: _previousError, ...baseWithoutError } = base;
  const running = { ...baseWithoutError, status: "running" as const, progress: 5 };
  await renderJobs.update(running);
  try {
    const outputKey = "renders/" + jobId + "." + outputExtension(job.data.settings.format);
    const outputPath = safeMediaPath(outputRoot, outputKey);
    const assetResolver = { resolve: async (assetId: string) => { const storageKey = job.data.assetStorageKeys[assetId]; if (!storageKey) throw new Error("Asset is missing from render manifest"); return safeMediaPath(mediaRoot, storageKey); } };
    const plan = await new FfmpegCommandPlanner(assetResolver).plan(job.data.revision, job.data.settings, outputPath);
    await job.updateProgress(25);
    await renderJobs.update({ ...running, progress: 25 });
    const controller = new AbortController();
    const cancellationWatcher = setInterval(() => { void renderJobs.get(jobId).then((latest) => { if (latest?.status === "cancelled") controller.abort(); }).catch(() => undefined); }, 1000);
    try { await processRunner.run(plan, controller.signal); } finally { clearInterval(cancellationWatcher); }
    const output = await checksum(outputPath);
    const succeeded: RenderJob = { ...running, status: "succeeded", progress: 100, output: { storageKey: outputKey, ...output, mimeType: job.data.settings.format === "webm" ? "video/webm" : "video/mp4" } };
    await renderJobs.update(succeeded);
    await job.updateProgress(100);
    return succeeded;
  } catch (error) {
    const latest = await renderJobs.get(jobId);
    if (latest?.status === "cancelled") return latest;
    const failed: RenderJob = { ...running, status: "failed", progress: running.progress, errorMessage: error instanceof Error ? error.message : "Render failed" };
    await renderJobs.update(failed);
    throw error;
  }
}, { connection: redisConnection(required("REDIS_URL")), concurrency: Number(process.env.RENDER_CONCURRENCY ?? "1") });

worker.on("completed", (job) => console.log(JSON.stringify({ event: "render.completed", jobId: job.id })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "render.failed", jobId: job?.id, error: error.message })));
worker.on("error", (error) => console.error(JSON.stringify({ event: "render.worker_error", error: error.message })));
const shutdown = async () => { await worker.close(); await pool.end(); };
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
