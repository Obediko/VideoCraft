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
import { processProxyTask, proxyTask, type MediaQueuePort } from "@videocraft/jobs";

export interface UploadDependencies {
  assets: AssetRepository;
  storage: ObjectStorage;
  scanner?: MalwareScanner;
  /** Extracts duration and stream metadata; uploads that cannot be decoded are rejected. */
  inspector?: (path: string) => Promise<MediaInfo>;
  /** Confirms an "image" upload decodes as a still image. */
  imageInspector?: (path: string) => Promise<boolean>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, minimumRole: "viewer" | "editor"): Promise<boolean> };
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  clock(): string;
  /** Builds a browser-playable preview for uploads browsers cannot play directly. Runs after the upload responds. */
  proxy?: (inputPath: string, outputPath: string) => Promise<void>;
  /** Called when background work finishes or fails (for logging and tests). */
  onBackgroundDone?: (assetId: UUID, outcome: "ready" | "failed", error?: unknown) => void;
  /** When set, proxies are built by the media worker instead of the API process. */
  proxyQueue?: MediaQueuePort;
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
          const code = (caught as NodeJS.ErrnoException | null)?.code;
          const unavailable = code === "ENOENT";
          const brokenPipe = code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE";
          request.log.error({ err: caught, requestId: request.id, projectId, assetId, stage: "media_inspection", errorCode: code ?? "unknown" }, "media inspection failed");
          return reply.code(unavailable || brokenPipe ? 503 : 422).send({
            error: {
              code: unavailable ? "media_inspector_unavailable" : brokenPipe ? "media_inspection_disconnected" : "invalid_media",
              message: unavailable ? "Media inspection is not available on this server" : brokenPipe ? "Media inspection stopped unexpectedly. Please retry the upload." : "The file could not be read as valid media.",
              requestId: request.id,
            },
          });
        }
        try {
          validateMedia(info);
          if (kind === "video" && !info.hasVideo) throw new Error("File has no video stream");
          if (kind === "audio" && !info.hasAudio) throw new Error("File has no audio stream");
        } catch (caught) { return error(reply, 422, "invalid_media", caught instanceof Error ? caught.message : "Invalid media"); }
      }
      if (dependencies.imageInspector && kind === "image") {
        let still = false;
        try { still = await dependencies.imageInspector(temporaryPath); }
        catch (caught) { if ((caught as NodeJS.ErrnoException)?.code === "ENOENT") return error(reply, 503, "media_inspector_unavailable", "Media inspection is not available on this server"); }
        if (!still) return error(reply, 422, "invalid_media", "The file could not be read as an image");
      }
      const needsProxy = Boolean((dependencies.proxy || dependencies.proxyQueue) && dependencies.assets.updateMetadata && info && kind === "video" && !isBrowserPlayable(info));
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
      const code = (caught as NodeJS.ErrnoException | null)?.code;
      const disconnected = code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE";
      request.log.error({ err: caught, requestId: request.id, projectId, assetId, stage: "upload", errorCode: code ?? "unknown" }, "media upload failed");
      return reply.code(disconnected ? 503 : 500).send({
        error: {
          code: disconnected ? "upload_connection_lost" : "upload_failed",
          message: disconnected
            ? "The media connection closed during upload or processing. Please retry and provide the reference ID if it persists."
            : "The video could not be uploaded. Please retry and provide the reference ID if it persists.",
          requestId: request.id,
        },
      });
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });
}

/** Hands the proxy to the media queue when there is one; otherwise builds it here, after the response. */
async function buildProxy(dependencies: UploadDependencies, asset: Asset): Promise<void> {
  if (dependencies.proxyQueue) {
    try { await dependencies.proxyQueue.enqueueProxy(asset); return; }
    catch (caught) { dependencies.onBackgroundDone?.(asset.id, "failed", caught); if (!dependencies.proxy) return; }
  }
  if (!dependencies.proxy) return;
  try {
    await processProxyTask(proxyTask(asset), { storage: dependencies.storage, assets: dependencies.assets, makeProxy: dependencies.proxy });
    dependencies.onBackgroundDone?.(asset.id, "ready");
  } catch (caught) {
    dependencies.onBackgroundDone?.(asset.id, "failed", caught);
  }
}

function isKind(value: unknown): value is Asset["kind"] {
  return value === "video" || value === "audio" || value === "image" || value === "caption";
}
function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
