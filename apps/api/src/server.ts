import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Asset, ProjectRevision, Timeline, UUID } from "@videocraft/domain";
import { ProjectService, type Clock, type IdFactory, type ProjectRepository, type AssetRepository, type RevisionRepository } from "@videocraft/application";

export interface Principal { userId: UUID; }
export interface Authenticator { authenticate(request: FastifyRequest): Promise<Principal | null>; }
export interface ProjectAuthorizer { canAccess(principal: Principal, projectId: UUID, minimumRole: "viewer" | "editor"): Promise<boolean>; }
export interface ApiDependencies {
  projects: ProjectRepository; assets: AssetRepository; revisions: RevisionRepository;
  authenticate: Authenticator; authorize: ProjectAuthorizer; clock?: Clock; ids?: IdFactory;
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
        acceptedProposalIds: Array.isArray(body.acceptedProposalIds)
          ? body.acceptedProposalIds.filter((value): value is string => typeof value === "string") : [],
      });
      return reply.code(201).send({ revision });
    } catch (error) {
      return sendError(reply, 400, "invalid_request", messageOf(error));
    }
  });

  return server;
}

async function authenticate(authenticator: Authenticator, request: FastifyRequest, reply: FastifyReply): Promise<Principal | null> {
  const principal = await authenticator.authenticate(request);
  if (!principal) { sendError(reply, 401, "unauthorized", "Authentication required"); return null; }
  return principal;
}
function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ error: { code, message } });
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Request failed"; }
function asRecord(value: unknown): Record<string, unknown> { return isJsonObject(value) ? value : {}; }
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMetadata(value: unknown): value is Record<string, string | number | boolean> {
  return isJsonObject(value) && Object.values(value).every((entry) =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean");
}
function isMediaKind(value: unknown): value is Asset["kind"] {
  return value === "video" || value === "audio" || value === "image" || value === "caption";
}
function isTimeline(value: unknown): value is Timeline {
  if (!isJsonObject(value) || typeof value.durationUs !== "number" || !Array.isArray(value.tracks)) return false;
  return value.tracks.every((track) => isJsonObject(track) && typeof track.id === "string" && typeof track.kind === "string" && Array.isArray(track.clips));
}
