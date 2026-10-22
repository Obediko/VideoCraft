import { createHash } from "node:crypto";
import type { AssetRepository } from "@videocraft/application";
import type { Project, ProjectRevision, RenderJob, RenderJobRepository, RenderSettings, RendererPort } from "@videocraft/domain";
import type { Queue } from "bullmq";

export interface RenderTask {
  jobId: string; project: Project; revision: ProjectRevision; settings: RenderSettings;
  idempotencyKey: string; assetStorageKeys: Record<string, string>;
}
export interface RenderQueueLike {
  add(name: string, data: RenderTask, options: { jobId: string; removeOnComplete: number; removeOnFail: number }): Promise<{ id?: string | number }>;
  getJob(jobId: string): Promise<{ id?: string | number; getState(): Promise<string> } | undefined>;
}
export class BullMqRenderQueue implements RendererPort {
  constructor(
    private readonly queue: RenderQueueLike | Queue<RenderTask>,
    private readonly assets?: AssetRepository,
    private readonly renderJobs?: RenderJobRepository,
  ) {}
  async enqueue(input: { project: Project; revision: ProjectRevision; settings: RenderSettings; idempotencyKey: string }): Promise<RenderJob> {
    const scopedIdempotencyKey = input.project.id + ":" + input.idempotencyKey;
    const jobId = "render-" + createHash("sha256").update(scopedIdempotencyKey).digest("hex");
    const persisted = await this.renderJobs?.get(jobId);
    if (persisted) return persisted;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const job: RenderJob = { id: String(existing.id ?? jobId), projectId: input.project.id, revision: input.revision.revision, settings: input.settings, idempotencyKey: input.idempotencyKey, status: await mapState(await existing.getState()), progress: 0 };
      await this.renderJobs?.save(job);
      return job;
    }
    const projectAssets = this.assets ? await this.assets.listForProject(input.project.id) : [];
    const assetStorageKeys = Object.fromEntries(projectAssets.map((asset) => [asset.id, asset.storageKey]));
    await this.queue.add("render", { jobId, project: input.project, revision: input.revision, settings: input.settings, idempotencyKey: input.idempotencyKey, assetStorageKeys }, { jobId, removeOnComplete: 1000, removeOnFail: 5000 });
    const job: RenderJob = { id: jobId, projectId: input.project.id, revision: input.revision.revision, settings: input.settings, idempotencyKey: input.idempotencyKey, status: "queued", progress: 0 };
    await this.renderJobs?.save(job);
    return job;
  }
}
async function mapState(state: string): Promise<RenderJob["status"]> {
  if (state === "completed") return "succeeded";
  if (state === "failed") return "failed";
  if (state === "active") return "running";
  if (state === "cancelled") return "cancelled";
  return "queued";
}

export { CloudflareQueueRenderQueue } from "./cloudflare.js";
