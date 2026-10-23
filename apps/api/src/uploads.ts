import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Asset, UUID } from "@videocraft/domain";
import type { AssetRepository } from "@videocraft/application";
import type { ObjectStorage } from "@videocraft/storage";
import type { MalwareScanner } from "@videocraft/security";
import { isBrowserPlayable, validateMedia, type MediaInfo } from "@videocraft/analysis";

export interface UploadDependencies {
  assets: AssetRepository;
  storage: ObjectStorage;
  scanner?: MalwareScanner;
  /** Extracts duration and stream metadata; uploads that cannot be decoded are rejected. */
  inspector?: (path: string) => Promise<MediaInfo>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, minimumRole: "viewer" | "editor"): Promise<boolean> };
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  clock(): string;
  /** Builds a browser-playable preview for uploads browsers cannot play directly. Runs after the upload responds. */
  proxy?: (inputPath: string, outputPath: string) => Promise<void>;
  /** Called when background work finishes or fails (for logging and tests). */
  onBackgroundDone?: (assetId: UUID, outcome: "ready" | "failed", error?: unknown) => void;
}

export function registerUploadRoutes(server: FastifyInstance, dependencies: UploadDependencies): void {
  server.register(multipart, { limits: { fileSize: 2_000_000_000, files: 1, fields: 8 } });
  server.post("/v1/projects/:projectId/assets/upload", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } } as any, async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string };
    const projectId = params.projectId;
    const kind = (request.query as { kind?: string }).kind;
    if (!projectId || !isKind(kind)) return error(reply, 400, "invalid_request", "projectId and a valid kind query parameter are required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return error(reply, 403, "forbidden", "Project access denied");

    const part = await request.file();
    if (!part) return error(reply, 400, "invalid_request", "A media file is required");
    const assetId = randomUUID();
    const temporaryDirectory = join(tmpdir(), "videocraft-upload");
    const temporaryPath = join(temporaryDirectory, assetId + ".uploading");
    const storageKey = "projects/" + projectId + "/assets/" + assetId + ".media";
    await mkdir(temporaryDirectory, { recursive: true });
    try {
      await pipeline(part.file, createWriteStream(temporaryPath, { flags: "wx" }));
      if (part.file.truncated) return error(reply, 413, "file_too_large", "The uploaded file exceeds the configured limit");
      if (dependencies.scanner) {
        let scan;
        try { scan = await dependencies.scanner.scan(temporaryPath); }
        catch (caught) { return error(reply, 503, "malware_scanner_unavailable", caught instanceof Error ? caught.message : "Malware scanner unavailable"); }
        if (!scan.clean) return error(reply, 422, "malware_detected", "The uploaded file was rejected by malware scanning");
      }
      let info: MediaInfo | undefined;
      if (dependencies.inspector && (kind === "video" || kind === "audio")) {
        try { info = await dependencies.inspector(temporaryPath); }
        catch (caught) {
          const unavailable = (caught as NodeJS.ErrnoException)?.code === "ENOENT";
          return error(reply, unavailable ? 503 : 422, unavailable ? "media_inspector_unavailable" : "invalid_media", unavailable ? "Media inspection is not available on this server" : "The file could not be read as media: " + (caught instanceof Error ? caught.message.slice(0, 200) : "unknown error"));
        }
        try {
          validateMedia(info);
          if (kind === "video" && !info.hasVideo) throw new Error("File has no video stream");
          if (kind === "audio" && !info.hasAudio) throw new Error("File has no audio stream");
        } catch (caught) { return error(reply, 422, "invalid_media", caught instanceof Error ? caught.message : "Invalid media"); }
      }
      const needsProxy = Boolean(dependencies.proxy && dependencies.assets.updateMetadata && info && kind === "video" && !isBrowserPlayable(info));
      const stored = await dependencies.storage.putFile(temporaryPath, storageKey);
      const asset: Asset = {
        id: assetId, projectId, kind, storageKey: stored.key, checksumSha256: stored.checksumSha256,
        ...(info ? { durationUs: info.durationUs } : {}),
        metadata: {
          filename: part.filename.slice(0, 255), mimeType: part.mimetype,
          ...(needsProxy ? { proxyStatus: "pending" } : {}),
          ...(info ? { hasVideo: info.hasVideo, hasAudio: info.hasAudio, container: info.formatName.slice(0, 80), ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}), ...(info.frameRate ? { frameRate: info.frameRate } : {}), ...(info.videoCodec ? { videoCodec: info.videoCodec } : {}), ...(info.audioCodec ? { audioCodec: info.audioCodec } : {}) } : {}),
        },
        createdAt: dependencies.clock(),
      };
      try {
        await dependencies.assets.save(asset);
      } catch (assetError) {
        await dependencies.storage.remove(storageKey).catch(() => undefined);
        throw assetError;
      }
      if (needsProxy) void buildProxy(dependencies, asset);
      return reply.code(201).send({ asset });
    } catch (caught) {
      return error(reply, 400, "upload_failed", caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });
}

/** Generates the playback proxy from the stored original, then records its key on the asset. */
async function buildProxy(dependencies: UploadDependencies, asset: Asset): Promise<void> {
  const directory = join(tmpdir(), "videocraft-proxy", asset.id);
  const proxyKey = "projects/" + asset.projectId + "/assets/" + asset.id + ".proxy.mp4";
  try {
    await mkdir(directory, { recursive: true });
    let inputPath = dependencies.storage.resolve(asset.storageKey);
    if (dependencies.storage.downloadToFile) { inputPath = join(directory, "input.media"); await dependencies.storage.downloadToFile(asset.storageKey, inputPath); }
    const outputPath = join(directory, "proxy.mp4");
    await dependencies.proxy!(inputPath, outputPath);
    await dependencies.storage.putFile(outputPath, proxyKey);
    await dependencies.assets.updateMetadata!(asset.id, { ...asset.metadata, proxyStatus: "ready", proxyKey });
    dependencies.onBackgroundDone?.(asset.id, "ready");
  } catch (caught) {
    await dependencies.assets.updateMetadata!(asset.id, { ...asset.metadata, proxyStatus: "failed" }).catch(() => undefined);
    dependencies.onBackgroundDone?.(asset.id, "failed", caught);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isKind(value: unknown): value is Asset["kind"] {
  return value === "video" || value === "audio" || value === "image" || value === "caption";
}
function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
