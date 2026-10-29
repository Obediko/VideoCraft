import { createHash } from "node:crypto";
import type { AssetRepository } from "@videocraft/application";
import type { Project, ProjectRevision, RenderJob, RenderJobRepository, RenderSettings, RendererPort } from "@videocraft/domain";
import { assetsUsedBy } from "@videocraft/domain";
import type { RenderTask } from "./index.js";

export interface CloudflareQueueOptions {
  accountId: string;
  queueId: string;
  apiToken: string;
  fetchFn?: typeof fetch;
}

type CloudflareQueueResponse = {
  success?: boolean;
  result?: { backlog_count?: number };
};

export class CloudflareQueueRenderQueue implements RendererPort {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly options: CloudflareQueueOptions,
    private readonly assets?: AssetRepository,
    private readonly renderJobs?: RenderJobRepository,
  ) {
    if (!options.accountId || !options.queueId || !options.apiToken) {
      throw new Error("Cloudflare Queues account, queue, and API token are required");
    }
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async enqueue(input: {
    project: Project;
    revision: ProjectRevision;
    settings: RenderSettings;
    idempotencyKey: string;
  }): Promise<RenderJob> {
    const scopedIdempotencyKey = input.project.id + ":" + input.idempotencyKey;
    const jobId = "render-" + createHash("sha256").update(scopedIdempotencyKey).digest("hex");
    const persisted = await this.renderJobs?.get(jobId);
    if (persisted) return persisted;

    const projectAssets = this.assets ? await this.assets.listForProject(input.project.id) : [];
    // Only the assets this revision uses are staged; a project's unused uploads are never downloaded.
    const used = assetsUsedBy(input.revision.timeline);
    const assetStorageKeys = Object.fromEntries(projectAssets.filter((asset) => used.has(asset.id)).map((asset) => [asset.id, asset.storageKey]));
    const task: RenderTask = {
      jobId,
      project: input.project,
      revision: input.revision,
      settings: input.settings,
      idempotencyKey: input.idempotencyKey,
      assetStorageKeys,
    };

    const response = await this.fetchFn(
      "https://api.cloudflare.com/client/v4/accounts/" +
        encodeURIComponent(this.options.accountId) +
        "/queues/" +
        encodeURIComponent(this.options.queueId) +
        "/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.options.apiToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: task }),
      },
    );
    if (!response.ok) {
      throw new Error("Cloudflare Queues publish failed with HTTP " + response.status);
    }

    const job: RenderJob = {
      id: jobId,
      projectId: input.project.id,
      revision: input.revision.revision,
      settings: input.settings,
      idempotencyKey: input.idempotencyKey,
      status: "queued",
      progress: 0,
    };
    await this.renderJobs?.save(job);
    return job;
  }

  async getJobCounts(): Promise<Record<string, number>> {
    const response = await this.fetchFn(
      "https://api.cloudflare.com/client/v4/accounts/" +
        encodeURIComponent(this.options.accountId) +
        "/queues/" +
        encodeURIComponent(this.options.queueId) +
        "/metrics",
      {
        method: "GET",
        headers: { Authorization: "Bearer " + this.options.apiToken },
      },
    );
    if (!response.ok) {
      throw new Error("Cloudflare Queues metrics failed with HTTP " + response.status);
    }
    const payload = (await response.json()) as CloudflareQueueResponse;
    return { waiting: payload.result?.backlog_count ?? 0 };
  }

  async close(): Promise<void> {}
}
