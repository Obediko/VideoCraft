import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { safeMediaPath } from "@videocraft/transcription";
import { FfmpegCommandPlanner, FfmpegProcess } from "@videocraft/rendering";
import { detectFocus, isStillImage, loadOrDetectFaceTrack, probeMedia } from "@videocraft/analysis";
import { LocalObjectStorage, S3ObjectStorage, sweepScratch, type ObjectStorage } from "@videocraft/storage";
import { PostgresRenderJobRepository, type Database } from "@videocraft/persistence";
import type { RenderTask } from "@videocraft/jobs";
import type { RenderJob } from "@videocraft/domain";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required");
  return value;
}

/** Runs the matte worker (it writes the matte video itself; output is a small JSON summary). */
function runMatte(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20 * 60_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("matte failed: " + stderr)); });
  });
}

function outputExtension(format: RenderTask["settings"]["format"]): string {
  return format === "webm" ? "webm" : "mp4";
}

export function createStorage(): ObjectStorage {
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
    // Folders of renders that were interrupted (a crash or a redeploy) are cleared after a day.
    void sweepScratch(safeMediaPath(this.outputRoot, "runs"), [""], 24 * 3600_000);
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
        isStill: async (assetId: string): Promise<boolean> => {
          const path = stagedAssets[assetId];
          if (!path) return false;
          try { return await isStillImage(path, process.env.FFPROBE_BIN ? { executable: process.env.FFPROBE_BIN } : {}); }
          catch { return false; }
        },
        // Face-aware reframing is optional: without REFRAME_SCRIPT (or on any detector failure) crops stay centred.
        focus: async (assetId: string, startUs: number, endUs: number) => {
          const script = process.env.REFRAME_SCRIPT;
          const path = stagedAssets[assetId];
          if (!script || !path) return null;
          try { return await detectFocus(path, startUs, endUs, { script, executable: process.env.REFRAME_PYTHON ?? "python3" }); }
          catch { return null; }
        },
        // Captions and text stay off the speaker's face. Optional: without FACES_SCRIPT (or on failure) they keep their place.
        faces: async (assetId: string) => {
          const script = process.env.FACES_SCRIPT;
          const path = stagedAssets[assetId]; const storageKey = task.assetStorageKeys[assetId];
          if (!script || !path || !storageKey) return null;
          try {
            return await loadOrDetectFaceTrack(this.storage, { projectId: task.project.id, assetId, storageKey }, { script, executable: process.env.REFRAME_PYTHON ?? "python3", ...(process.env.RENDER_WORK_ROOT ? { workRoot: process.env.RENDER_WORK_ROOT } : {}) }, path);
          } catch { return null; }
        },
        // Person matte for background changes and cutaways behind the speaker (optional: without MATTE_SCRIPT they are skipped).
        matte: async (assetId: string, startUs: number, endUs: number, options: { edge: number; feather: number }) => {
          const script = process.env.MATTE_SCRIPT;
          const path = stagedAssets[assetId];
          if (!script || !path) return null;
          const out = safeRunPath(this.outputRoot, jobId, "mattes/" + createHash("sha256").update([assetId, startUs, endUs, options.edge, options.feather].join(":")).digest("hex") + ".mp4");
          await mkdir(out.slice(0, out.lastIndexOf("/")), { recursive: true });
          try { await runMatte(process.env.REFRAME_PYTHON ?? "python3", [script, path, (startUs / 1e6).toFixed(3), (endUs / 1e6).toFixed(3), out, String(options.edge), String(options.feather)]); return out; }
          catch { return null; }
        },
        dimensions: async (assetId: string) => {
          const path = stagedAssets[assetId];
          if (!path) return null;
          try { const info = await probeMedia(path, process.env.FFPROBE_BIN ? { executable: process.env.FFPROBE_BIN } : {}); return info.width && info.height ? { width: info.width, height: info.height } : null; }
          catch { return null; }
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

      // FFmpeg exiting successfully does not prove that a playable picture was written.
      const outputInfo = await probeMedia(outputPath, process.env.FFPROBE_BIN ? { executable: process.env.FFPROBE_BIN } : {});
      const outputStat = await stat(outputPath);
      const expectedUs = task.revision.timeline.tracks
        .filter((track) => track.kind === "video")
        .flatMap((track) => track.clips)
        .reduce((total, clip) => total + Math.max(0, clip.sourceEndUs - clip.sourceStartUs), 0);
      if (!outputInfo.hasVideo || !outputInfo.width || !outputInfo.height || outputStat.size === 0) {
        throw new Error("Render validation failed: the exported file has no usable video stream");
      }
      if (expectedUs > 0 && outputInfo.durationUs < expectedUs * 0.8) {
        throw new Error("Render validation failed: video duration is unexpectedly short");
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
