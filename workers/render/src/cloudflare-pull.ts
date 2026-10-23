import { isMediaTask, type MediaTask, type RenderTask } from "@videocraft/jobs";
import type { RenderTaskProcessor } from "./processor.js";
import type { MediaTaskProcessor } from "./media.js";

const MEDIA_MAX_ATTEMPTS = 3;

type PulledMessage = { body: unknown; lease_id: string; id: string; attempts?: number };
type PullResponse = { success?: boolean; result?: { messages?: PulledMessage[]; message_backlog_count?: number } };
type AckResponse = { success?: boolean };

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required");
  return value;
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(name + " must be between " + min + " and " + max);
  return value;
}

function endpoint(accountId: string, queueId: string, action: "pull" | "ack"): string {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(accountId) +
    "/queues/" + encodeURIComponent(queueId) + "/messages/" + action;
}

async function requestJson<T>(url: string, token: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await response.json() as T & { success?: boolean };
  if (!response.ok || payload.success === false) throw new Error("Cloudflare Queues request failed with HTTP " + response.status);
  return payload;
}

export function parseTask(body: unknown): RenderTask | MediaTask {
  const value = typeof body === "string" ? JSON.parse(body) : body;
  const unwrapped = value && typeof value === "object" && "body" in value ? (value as { body: unknown }).body : value;
  const task = typeof unwrapped === "string" ? JSON.parse(unwrapped) : unwrapped;
  if (isMediaTask(task)) return task;
  if (!task || typeof task !== "object" || typeof (task as { jobId?: unknown }).jobId !== "string") {
    throw new Error("Cloudflare queue message is not a render task");
  }
  return task as RenderTask;
}

export async function runCloudflarePullConsumer(processor: RenderTaskProcessor, signal: AbortSignal, media?: MediaTaskProcessor): Promise<void> {
  const accountId = required("CF_ACCOUNT_ID");
  const queueId = required("CF_QUEUE_ID");
  const token = required("CF_QUEUES_API_TOKEN");
  const batchSize = integerEnv("CF_QUEUE_BATCH_SIZE", 1, 1, 100);
  const visibilityTimeoutMs = integerEnv("CF_QUEUE_VISIBILITY_TIMEOUT_MS", 3_600_000, 1_000, 43_200_000);
  const pollIntervalMs = integerEnv("CF_QUEUE_POLL_INTERVAL_MS", 2_000, 250, 60_000);

  while (!signal.aborted) {
    const pulled = await requestJson<PullResponse>(endpoint(accountId, queueId, "pull"), token, {
      method: "POST",
      body: JSON.stringify({ batch_size: batchSize, visibility_timeout_ms: visibilityTimeoutMs }),
    });
    const messages = pulled.result?.messages ?? [];
    if (messages.length === 0) {
      await delay(pollIntervalMs, signal);
      continue;
    }

    const acks: Array<{ lease_id: string }> = [];
    const retries: Array<{ lease_id: string; delay_seconds: number }> = [];
    for (const message of messages) {
      try {
        const task = parseTask(message.body);
        if (isMediaTask(task)) {
          // Media tasks get a bounded number of attempts; the last one records the failure and is acknowledged.
          const final = (message.attempts ?? 1) >= MEDIA_MAX_ATTEMPTS;
          try {
            const outcome = media ? await media.process(task, { final }) : "skipped";
            console.log(JSON.stringify({ event: "media.acknowledged", jobId: task.jobId, outcome }));
            acks.push({ lease_id: message.lease_id });
          } catch (error) {
            if (!final) throw error;
            console.error(JSON.stringify({ event: "media.failed", jobId: task.jobId, error: error instanceof Error ? error.message : "unknown error" }));
            acks.push({ lease_id: message.lease_id });
          }
          continue;
        }
        const result = await processor.process(task, { update: async () => undefined });
        if (result.status === "failed") throw new Error(result.errorMessage ?? "Render failed");
        acks.push({ lease_id: message.lease_id });
        console.log(JSON.stringify({ event: "render.acknowledged", jobId: task.jobId, messageId: message.id }));
      } catch (error) {
        retries.push({ lease_id: message.lease_id, delay_seconds: Math.min(300, Math.max(30, (message.attempts ?? 1) * 30)) });
        console.error(JSON.stringify({ event: "render.retry", messageId: message.id, error: error instanceof Error ? error.message : "unknown error" }));
      }
    }
    if (acks.length > 0 || retries.length > 0) {
      await requestJson<AckResponse>(endpoint(accountId, queueId, "ack"), token, {
        method: "POST",
        body: JSON.stringify({ acks, retries }),
      });
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
