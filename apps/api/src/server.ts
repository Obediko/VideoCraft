import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Asset, ProjectRevision, RenderSettings, RendererPort, Timeline, TranscriptSegment, TranscriptionPort, UUID } from "@videocraft/domain";
import { ProjectService, type Clock, type IdFactory, type ProjectRepository, type AssetRepository, type RevisionRepository } from "@videocraft/application";

export interface Principal { userId: UUID; }
export interface Authenticator { authenticate(request: FastifyRequest): Promise<Principal | null>; }
export interface ProjectAuthorizer { canAccess(principal: Principal, projectId: UUID, minimumRole: "viewer" | "editor"): Promise<boolean>; }
export interface TranscriptStore {
  replaceForAsset(assetId: UUID, segments: TranscriptSegment[]): Promise<void>;
  listForAsset(assetId: UUID): Promise<TranscriptSegment[]>;
}
export interface ApiDependencies {
  projects: ProjectRepository; assets: AssetRepository; revisions: RevisionRepository;
  authenticate: Authenticator; authorize: ProjectAuthorizer;
  renderer?: RendererPort; transcriber?: TranscriptionPort; transcripts?: TranscriptStore;
  clock?: Clock; ids?: IdFactory;
}

export function buildServer(dependencies: ApiDependencies): FastifyInstance {
  const server = Fastify({ logger: true, bodyLimit: 1_000_000 });
  const clock = dependencies.clock ?? { now: () => new Date().toISOString() };
  const ids = dependencies.ids ?? { next: () => randomUUID() };
  const projectService = new ProjectService(dependencies.projects, dependencies.assets, dependencies.revisions, ids, clock);

  server.get("/healthz", async () => ({ status: "ok" }));

  server.post("/v1/projects", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const body = asRecord(request.body);
    if (typeof body.name !== "string") return sendError(reply, 400, "invalid_request", "name is required");
    try {
      const project = await projectService.createProject({ ownerId: principal.userId, name: body.name });
      return reply.code(201).send({ project });
    } catch (error) {
      return sendError(reply, 400, "invalid_request", messageOf(error));
    }
  });

  server.post("/v1/projects/:projectId/assets", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const body = asRecord(request.body);
    const kind = body.kind;
    const storageKey = body.storageKey;
    const checksumSha256 = body.checksumSha256;
    if (!isMediaKind(kind) || typeof storageKey !== "string" || typeof checksumSha256 !== "string") {
      return sendError(reply, 400, "invalid_request", "kind, storageKey, and checksumSha256 are required");
    }
    const asset: Asset = {
      id: ids.next(), projectId, kind, storageKey, checksumSha256,
      ...(typeof body.durationUs === "number" ? { durationUs: body.durationUs } : {}),
      metadata: isMetadata(body.metadata) ? body.metadata : {},
      createdAt: clock.now(),
    };
    try {
      await projectService.addAsset(asset);
      return reply.code(201).send({ asset });
    } catch (error) {
      return sendError(reply, 400, "invalid_request", messageOf(error));
    }
  });

  server.post("/v1/projects/:projectId/assets/:assetId/transcript", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.transcriber || !dependencies.transcripts) return sendError(reply, 503, "transcriber_unavailable", "Transcription service is not configured");
    const params = asRecord(request.params);
    const projectId = params.projectId;
    const assetId = params.assetId;
    if (typeof projectId !== "string" || typeof assetId !== "string") return sendError(reply, 400, "invalid_request", "projectId and assetId are required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const asset = (await dependencies.assets.listForProject(projectId)).find((candidate) => candidate.id === assetId);
    if (!asset) return sendError(reply, 404, "not_found", "Asset not found");

    try {
      const segments = await dependencies.transcriber.transcribe(asset);
      if (segments.some((segment) => segment.assetId !== assetId || segment.endUs <= segment.startUs || segment.startUs < 0)) {
        return sendError(reply, 502, "invalid_provider_response", "Transcription provider returned invalid segments");
      }
      await dependencies.transcripts.replaceForAsset(assetId, segments);
      return reply.code(201).send({ assetId, segments });
    } catch (error) {
      return sendError(reply, 503, "transcriber_unavailable", messageOf(error));
    }
  });

  server.get("/v1/projects/:projectId/assets/:assetId/transcript", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.transcripts) return sendError(reply, 503, "transcriber_unavailable", "Transcript storage is not configured");
    const params = asRecord(request.params);
    const projectId = params.projectId;
    const assetId = params.assetId;
    if (typeof projectId !== "string" || typeof assetId !== "string") return sendError(reply, 400, "invalid_request", "projectId and assetId are required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "viewer"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const asset = (await dependencies.assets.listForProject(projectId)).find((candidate) => candidate.id === assetId);
    if (!asset) return sendError(reply, 404, "not_found", "Asset not found");
    return { assetId, segments: await dependencies.transcripts.listForAsset(assetId) };
  });

  server.post("/v1/projects/:projectId/revisions", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const body = asRecord(request.body);
    if (!isTimeline(body.timeline)) return sendError(reply, 400, "invalid_request", "timeline is required");
    try {
      const revision = await projectService.saveRevision({
        projectId, createdBy: principal.userId, timeline: body.timeline,
        ...(isJsonObject(body.tailoring) ? { tailoring: body.tailoring as ProjectRevision["tailoring"] } : {}),
        acceptedProposalIds: Array.isArray(body.acceptedProposalIds) ? body.acceptedProposalIds.filter((value): value is string => typeof value === "string") : [],
      });
      return reply.code(201).send({ revision });
    } catch (error) {
      return sendError(reply, 400, "invalid_request", messageOf(error));
    }
  });

  server.post("/v1/projects/:projectId/renders", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.renderer) return sendError(reply, 503, "renderer_unavailable", "Render service is not configured");
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const body = asRecord(request.body);
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) return sendError(reply, 400, "invalid_request", "revision must be a positive integer");
    if (!isRenderSettings(body.settings) || typeof body.idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{8,200}$/.test(body.idempotencyKey)) {
      return sendError(reply, 400, "invalid_request", "settings and a valid idempotencyKey are required");
    }
    const [project, revision] = await Promise.all([dependencies.projects.get(projectId), dependencies.revisions.get(projectId, body.revision as number)]);
    if (!project || !revision) return sendError(reply, 404, "not_found", "Project revision not found");
    try {
      const job = await dependencies.renderer.enqueue({ project, revision, settings: body.settings, idempotencyKey: body.idempotencyKey });
      return reply.code(202).send({ job });
    } catch (error) {
      return sendError(reply, 503, "render_unavailable", messageOf(error));
    }
  });

  return server;
}
async function authenticate(authenticator: Authenticator, request: FastifyRequest, reply: FastifyReply): Promise<Principal | null> {
  const principal = await authenticator.authenticate(request);
  if (!principal) { sendError(reply, 401, "unauthorized", "Authentication required"); return null; }
  return principal;
}
function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) { return reply.code(statusCode).send({ error: { code, message } }); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Request failed"; }
function asRecord(value: unknown): Record<string, unknown> { return isJsonObject(value) ? value : {}; }
function isJsonObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMetadata(value: unknown): value is Record<string, string | number | boolean> {
  return isJsonObject(value) && Object.values(value).every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean");
}
function isMediaKind(value: unknown): value is Asset["kind"] { return value === "video" || value === "audio" || value === "image" || value === "caption"; }
function isTimeline(value: unknown): value is Timeline {
  if (!isJsonObject(value) || typeof value.durationUs !== "number" || !Array.isArray(value.tracks)) return false;
  return value.tracks.every((track) => isJsonObject(track) && typeof track.id === "string" && typeof track.kind === "string" && Array.isArray(track.clips));
}
function isRenderSettings(value: unknown): value is RenderSettings {
  if (!isJsonObject(value)) return false;
  const formats = value.format === "mp4" || value.format === "webm";
  const codecs = (value.videoCodec === "libx264" || value.videoCodec === "libvpx-vp9") && (value.audioCodec === "aac" || value.audioCodec === "libopus");
  return formats && codecs && Number.isInteger(value.width) && Number.isInteger(value.height) && Number.isInteger(value.frameRate) && (value.width as number) >= 2 && (value.height as number) >= 2 && (value.frameRate as number) > 0 && (value.frameRate as number) <= 120;
}
