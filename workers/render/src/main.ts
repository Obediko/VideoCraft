import { Worker, type Job } from "bullmq";
import { createPool, type Database } from "@videocraft/persistence";
import type { MediaTask, RenderTask } from "@videocraft/jobs";
import { MediaTaskProcessor } from "./media.js";
import { RenderTaskProcessor } from "./processor.js";
import { runCloudflarePullConsumer } from "./cloudflare-pull.js";

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

const pool = createPool(required("DATABASE_URL"));
const processor = new RenderTaskProcessor(pool as unknown as Database);
await processor.initialize();
const media = new MediaTaskProcessor(pool as unknown as Database);

const shutdownController = new AbortController();
let bullWorker: Worker<RenderTask> | undefined;
let mediaWorker: Worker<MediaTask> | undefined;

async function shutdown(): Promise<void> {
  if (!shutdownController.signal.aborted) shutdownController.abort();
  await bullWorker?.close();
  await mediaWorker?.close();
  await pool.end();
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

try {
  if ((process.env.JOB_QUEUE_PROVIDER ?? "bullmq") === "cloudflare") {
    console.log(JSON.stringify({ event: "render.worker_started", provider: "cloudflare" }));
    await runCloudflarePullConsumer(processor, shutdownController.signal, media);
  } else {
    bullWorker = new Worker<RenderTask>("videocraft-render", async (job: Job<RenderTask>) => {
      const result = await processor.process(job.data, { update: (percent) => job.updateProgress(percent) });
      return result;
    }, {
      connection: redisConnection(required("REDIS_URL")),
      concurrency: Number(process.env.RENDER_CONCURRENCY ?? "1"),
    });
    bullWorker.on("completed", (job) => console.log(JSON.stringify({ event: "render.completed", jobId: job.id })));
    bullWorker.on("failed", (job, error) => console.error(JSON.stringify({ event: "render.failed", jobId: job?.id, error: error.message })));
    bullWorker.on("error", (error) => console.error(JSON.stringify({ event: "render.worker_error", error: error.message })));
    // Preview proxies run on their own queue so a long render never delays them (and vice versa).
    mediaWorker = new Worker<MediaTask>("videocraft-media", async (job: Job<MediaTask>) => media.process(job.data, { final: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) }), {
      connection: redisConnection(required("REDIS_URL")),
      concurrency: Number(process.env.MEDIA_CONCURRENCY ?? "1"),
    });
    mediaWorker.on("completed", (job, outcome) => console.log(JSON.stringify({ event: "media.completed", jobId: job.id, outcome })));
    mediaWorker.on("failed", (job, error) => console.error(JSON.stringify({ event: "media.failed", jobId: job?.id, attempt: job?.attemptsMade, error: error.message })));
    console.log(JSON.stringify({ event: "render.worker_started", provider: "bullmq" }));
    await new Promise<void>((resolve) => shutdownController.signal.addEventListener("abort", () => resolve(), { once: true }));
  }
} finally {
  await shutdown();
}
