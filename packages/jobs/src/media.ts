import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset, UUID } from "@videocraft/domain";

/** Background media work that should not run inside the API process. */
export interface ProxyTask { type: "proxy"; jobId: string; assetId: UUID; projectId: UUID; storageKey: string; }
export type MediaTask = ProxyTask;

export interface MediaQueuePort { enqueueProxy(asset: Pick<Asset, "id" | "projectId" | "storageKey">): Promise<void>; }

export function proxyTask(asset: Pick<Asset, "id" | "projectId" | "storageKey">): ProxyTask {
  return { type: "proxy", jobId: "proxy-" + asset.id, assetId: asset.id, projectId: asset.projectId, storageKey: asset.storageKey };
}
export function isMediaTask(value: unknown): value is MediaTask {
  const task = value as Partial<ProxyTask> | null;
  return Boolean(task && task.type === "proxy" && typeof task.assetId === "string" && typeof task.projectId === "string" && typeof task.storageKey === "string" && typeof task.jobId === "string");
}

export interface MediaQueueLike { add(name: string, data: MediaTask, options: Record<string, unknown>): Promise<unknown>; }
/** BullMQ producer: three attempts with exponential back-off; one job per asset. */
export class BullMqMediaQueue implements MediaQueuePort {
  constructor(private readonly queue: MediaQueueLike, private readonly options: { attempts?: number; backoffMs?: number } = {}) {}
  async enqueueProxy(asset: Pick<Asset, "id" | "projectId" | "storageKey">): Promise<void> {
    const task = proxyTask(asset);
    await this.queue.add("proxy", task, { jobId: task.jobId, attempts: this.options.attempts ?? 3, backoff: { type: "exponential", delay: this.options.backoffMs ?? 30_000 }, removeOnComplete: 1000, removeOnFail: 5000 });
  }
}

/** Cloudflare Queues producer: media tasks share the render queue and are told apart by `type`. */
export class CloudflareMediaQueue implements MediaQueuePort {
  private readonly fetchFn: typeof fetch;
  constructor(private readonly options: { accountId: string; queueId: string; apiToken: string; fetchFn?: typeof fetch }) {
    if (!options.accountId || !options.queueId || !options.apiToken) throw new Error("Cloudflare Queues account, queue, and API token are required");
    this.fetchFn = options.fetchFn ?? fetch;
  }
  async enqueueProxy(asset: Pick<Asset, "id" | "projectId" | "storageKey">): Promise<void> {
    const response = await this.fetchFn("https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(this.options.accountId) + "/queues/" + encodeURIComponent(this.options.queueId) + "/messages", {
      method: "POST", headers: { Authorization: "Bearer " + this.options.apiToken, "Content-Type": "application/json" }, body: JSON.stringify({ body: proxyTask(asset) }),
    });
    if (!response.ok) throw new Error("Cloudflare Queues publish failed with HTTP " + response.status);
  }
}

export interface ProxyDependencies {
  storage: { resolve(key: string): string; putFile(path: string, key: string): Promise<unknown>; downloadToFile?(key: string, path: string): Promise<void> };
  assets: { listForProject(projectId: UUID): Promise<Asset[]>; updateMetadata?(assetId: UUID, metadata: Asset["metadata"]): Promise<void> };
  makeProxy(inputPath: string, outputPath: string): Promise<void>;
  workRoot?: string;
}

/**
 * Builds the browser preview for one asset and records it. Idempotent: an asset whose proxy is ready is
 * skipped. On a failure the error is rethrown so the queue retries; only the final attempt marks it failed.
 */
export async function processProxyTask(task: ProxyTask, deps: ProxyDependencies, attempt: { final: boolean } = { final: true }): Promise<"ready" | "skipped"> {
  if (!deps.assets.updateMetadata) throw new Error("Asset repository cannot record proxy status");
  const asset = (await deps.assets.listForProject(task.projectId)).find((candidate) => candidate.id === task.assetId);
  if (!asset || asset.storageKey !== task.storageKey) return "skipped";
  if (asset.metadata.proxyStatus === "ready") return "skipped";
  const directory = join(deps.workRoot ?? tmpdir(), "videocraft-proxy", task.assetId);
  const proxyKey = "projects/" + task.projectId + "/assets/" + task.assetId + ".proxy.mp4";
  try {
    await mkdir(directory, { recursive: true });
    // Remote storage (R2/S3) has no local path, so stage the object before calling resolve().
    let inputPath: string;
    if (deps.storage.downloadToFile) { inputPath = join(directory, "input.media"); await deps.storage.downloadToFile(task.storageKey, inputPath); }
    else inputPath = deps.storage.resolve(task.storageKey);
    const outputPath = join(directory, "proxy.mp4");
    await deps.makeProxy(inputPath, outputPath);
    await deps.storage.putFile(outputPath, proxyKey);
    await deps.assets.updateMetadata(asset.id, { ...asset.metadata, proxyStatus: "ready", proxyKey });
    return "ready";
  } catch (error) {
    if (attempt.final) await deps.assets.updateMetadata(asset.id, { ...asset.metadata, proxyStatus: "failed" }).catch(() => undefined);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
