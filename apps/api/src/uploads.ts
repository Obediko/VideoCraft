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

export interface UploadDependencies {
  assets: AssetRepository;
  storage: ObjectStorage;
  scanner?: MalwareScanner;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, minimumRole: "viewer" | "editor"): Promise<boolean> };
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  clock(): string;
}

export function registerUploadRoutes(server: FastifyInstance, dependencies: UploadDependencies): void {
  server.register(multipart, { limits: { fileSize: 2_000_000_000, files: 1, fields: 8 } });
  server.post("/v1/projects/:projectId/assets/upload", async (request, reply) => {
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
        catch (error) { return error(reply, 503, "malware_scanner_unavailable", error instanceof Error ? error.message : "Malware scanner unavailable"); }
        if (!scan.clean) return errorResponse(reply, 422, "malware_detected", "The uploaded file was rejected by malware scanning");
      }
      const stored = await dependencies.storage.putFile(temporaryPath, storageKey);
      const asset: Asset = {
        id: assetId, projectId, kind, storageKey: stored.key, checksumSha256: stored.checksumSha256,
        metadata: { filename: part.filename.slice(0, 255), mimeType: part.mimetype },
        createdAt: dependencies.clock(),
      };
      try {
        await dependencies.assets.save(asset);
      } catch (assetError) {
        await dependencies.storage.remove(storageKey).catch(() => undefined);
        throw assetError;
      }
      return reply.code(201).send({ asset });
    } catch (caught) {
      return error(reply, 400, "upload_failed", caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });
}

function isKind(value: unknown): value is Asset["kind"] {
  return value === "video" || value === "audio" || value === "image" || value === "caption";
}
function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
