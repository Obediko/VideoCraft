import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { safeMediaPath } from "@videocraft/transcription";
import { FfmpegCommandPlanner, FfmpegProcess } from "@videocraft/rendering";
import { probeMedia } from "@videocraft/analysis";
import { LocalObjectStorage, S3ObjectStorage, type ObjectStorage } from "@videocraft/storage";
import { PostgresRenderJobRepository, type Database } from "@videocraft/persistence";
import type { RenderTask } from "@videocraft/jobs";
import type { RenderJob } from "@videocraft/domain";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required");
  return value;
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

export interface RenderProgress {
  update(percent: number): Promise<void>;
}

export class RenderTaskProcessor {
  private readonly storage: ObjectStorage;
  private readonly outputRoot: string;
  private readonly renderJobs: PostgresRenderJobRepository;
  private readonly processRunner: FfmpegProcess;

  constructor(pool: Database) {
    this.storage = createStorage();
    this.outputRoot = process.env.RENDER_WORK_ROOT ?? required("RENDER_ROOT");
    this.renderJobs = new PostgresRenderJobRepository(pool);
    this.processRunner = new FfmpegProcess(process.env.FFMPEG_BIN ?? "ffmpeg");
  }

  async initialize(): Promise<void> {
    await mkdir(this.outputRoot, { recursive: true });
  }

  async process(task: RenderTask, progress: RenderProgress): Promise<RenderJob> {
    const jobId = task.jobId;
    const { errorMessage: _previousError, ...baseWithoutError } = await (async () => {
      const record = await this.renderJobs.get(jobId);
      const base: RenderJob = record ?? {
        id: jobId,
        projectId: task.project.id,
        revision: task.revision.revision,
        settings: task.settings,
        idempotencyKey: task.idempotencyKey,
        status: "queued",
        progress: 0,
      };
      if (!record) await this.renderJobs.save(base);
      return base;
    })();

    if (baseWithoutError.status === "succeeded") return baseWithoutError;
    if (baseWithoutError.status === "cancelled") return baseWithoutError;

    const running = { ...baseWithoutError, status: "running" as const, progress: 5 };
    await this.renderJobs.update(running);
    const runRoot = safeMediaPath(this.outputRoot, "runs/" + jobId);
    await mkdir(runRoot, { recursive: true });

    try {
      const stagedAssets = await this.stageInputs(task);
      const extension = outputExtension(task.settings.format);
      const outputKey = "projects/" + task.project.id + "/renders/" + jobId + "." + extension;
      const outputPath = safeRunPath(this.outputRoot, jobId, "output." + extension);
      const assetResolver = {
        resolve: async (assetId: string): Promise<string> => {
          const path = stagedAssets[assetId];
          if (!path) throw new Error("Asset is missing from render manifest");
          return path;
        },
        hasAudio: async (assetId: string): Promise<boolean> => {
          const path = stagedAssets[assetId];
          if (!path) return false;
          return (await probeMedia(path, process.env.FFPROBE_BIN ? { executable: process.env.FFPROBE_BIN } : {})).hasAudio;
        },
      };
      const plan = await new FfmpegCommandPlanner(assetResolver).plan(task.revision, task.settings, outputPath);
      await progress.update(25);
      await this.renderJobs.update({ ...running, progress: 25 });

      const controller = new AbortController();
      const cancellationWatcher = setInterval(() => {
        void this.renderJobs.get(jobId).then((latest) => {
          if (latest?.status === "cancelled") controller.abort();
        }).catch(() => undefined);
      }, 1000);
      try {
        await this.processRunner.run(plan, controller.signal);
      } finally {
        clearInterval(cancellationWatcher);
      }

      const stored = await this.storage.putFile(outputPath, outputKey);
      const succeeded: RenderJob = {
        ...running,
        status: "succeeded",
        progress: 100,
        output: {
          storageKey: stored.key,
          checksumSha256: stored.checksumSha256,
          sizeBytes: stored.size,
          mimeType: task.settings.format === "webm" ? "video/webm" : "video/mp4",
        },
      };
      await this.renderJobs.update(succeeded);
      await progress.update(100);
      return succeeded;
    } catch (error) {
      const latest = await this.renderJobs.get(jobId);
      if (latest?.status === "cancelled") return latest;
      const failed: RenderJob = {
        ...running,
        status: "failed",
        progress: running.progress,
        errorMessage: error instanceof Error ? error.message : "Render failed",
      };
      await this.renderJobs.update(failed);
      throw error;
    } finally {
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async stageInputs(task: RenderTask): Promise<Record<string, string>> {
    if (!this.storage.downloadToFile) throw new Error("Configured storage provider cannot stage media for rendering");
    const staged: Record<string, string> = {};
    for (const [assetId, storageKey] of Object.entries(task.assetStorageKeys)) {
      const destination = safeRunPath(this.outputRoot, task.jobId, "inputs/" + createHash("sha256").update(storageKey).digest("hex"));
      await mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
      await this.storage.downloadToFile(storageKey, destination);
      staged[assetId] = destination;
    }
    return staged;
  }
}
