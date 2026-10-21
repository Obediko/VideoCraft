import { mkdir } from "node:fs/promises";
import { Worker, type Job } from "bullmq";
import { safeMediaPath } from "@videocraft/transcription";
import { FfmpegCommandPlanner, FfmpegProcess } from "@videocraft/rendering";
import type { RenderTask } from "@videocraft/jobs";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
}
function redisConnection(value: string) {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL must use redis:// or rediss://");
  return {
    host: url.hostname, port: Number(url.port || "6379"),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}
function outputExtension(format: RenderTask["settings"]["format"]): string {
  return format === "webm" ? "webm" : "mp4";
}

const mediaRoot = required("MEDIA_ROOT");
const outputRoot = required("RENDER_ROOT");
await mkdir(outputRoot, { recursive: true });
const processRunner = new FfmpegProcess(process.env.FFMPEG_BIN ?? "ffmpeg");
const worker = new Worker<RenderTask>("videocraft-render", async (job: Job<RenderTask>) => {
  const outputPath = safeMediaPath(outputRoot, job.id + "." + outputExtension(job.data.settings.format));
  const assetResolver = {
    resolve: async (assetId: string) => {
      const storageKey = job.data.assetStorageKeys[assetId];
      if (!storageKey) throw new Error("Asset is missing from render manifest");
      return safeMediaPath(mediaRoot, storageKey);
    },
  };
  const plan = await new FfmpegCommandPlanner(assetResolver).plan(job.data.revision, job.data.settings, outputPath);
  await job.updateProgress(25);
  await processRunner.run(plan);
  await job.updateProgress(100);
  return { outputPath };
}, { connection: redisConnection(required("REDIS_URL")), concurrency: Number(process.env.RENDER_CONCURRENCY ?? "1") });

worker.on("completed", (job) => console.log(JSON.stringify({ event: "render.completed", jobId: job.id })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "render.failed", jobId: job?.id, error: error.message })));
worker.on("error", (error) => console.error(JSON.stringify({ event: "render.worker_error", error: error.message })));

const shutdown = async () => { await worker.close(); };
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
