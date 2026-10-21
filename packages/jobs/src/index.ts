import { createHash } from "node:crypto";
import type { Project, ProjectRevision, RenderJob, RenderSettings, RendererPort } from "@videocraft/domain";
import type { Queue } from "bullmq";

export interface RenderTask {
  jobId: string;
  project: Project;
  revision: ProjectRevision;
  settings: RenderSettings;
  idempotencyKey: string;
}

export interface RenderQueueLike {
  add(name: string, data: RenderTask, options: { jobId: string; removeOnComplete: number; removeOnFail: number }): Promise<{ id?: string | number }>;
  getJob(jobId: string): Promise<{ id?: string | number; getState(): Promise<string> } | undefined>;
}

export class BullMqRenderQueue implements RendererPort {
  constructor(private readonly queue: RenderQueueLike | Queue<RenderTask>) {}

  async enqueue(input: {
    project: Project;
    revision: ProjectRevision;
    settings: RenderSettings;
    idempotencyKey: string;
  }): Promise<RenderJob> {
    const jobId = "render-" + createHash("sha256").update(input.idempotencyKey).digest("hex");
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      return {
        id: String(existing.id ?? jobId),
        projectId: input.project.id,
        revision: input.revision.revision,
        settings: input.settings,
        idempotencyKey: input.idempotencyKey,
        status: await mapState(existing.getState()),
      };
    }

    await this.queue.add("render", {
      jobId,
      project: input.project,
      revision: input.revision,
      settings: input.settings,
      idempotencyKey: input.idempotencyKey,
    }, { jobId, removeOnComplete: 1000, removeOnFail: 5000 });

    return {
      id: jobId,
      projectId: input.project.id,
      revision: input.revision.revision,
      settings: input.settings,
      idempotencyKey: input.idempotencyKey,
      status: "queued",
    };
  }
}

async function mapState(state: string): Promise<RenderJob["status"]> {
  if (state === "completed") return "succeeded";
  if (state === "failed") return "failed";
  if (state === "active") return "running";
  if (state === "cancelled") return "cancelled";
  return "queued";
}
