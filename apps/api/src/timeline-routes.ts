import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProjectRevision, UUID } from "@videocraft/domain";
import { exportOtio, importOtio } from "@videocraft/timeline-interchange";
import type { ProjectRepository, RevisionRepository } from "@videocraft/application";

export interface TimelineRouteDependencies {
  projects: ProjectRepository; revisions: RevisionRepository;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, role: "viewer" | "editor"): Promise<boolean> };
  saveRevision(input: { projectId: UUID; createdBy: UUID; timeline: ProjectRevision["timeline"]; acceptedProposalIds: UUID[] }): Promise<ProjectRevision>;
}
export function registerTimelineRoutes(server: FastifyInstance, dependencies: TimelineRouteDependencies): void {
  server.post("/v1/projects/:projectId/timeline/export", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string };
    if (!params.projectId || !(await dependencies.authorize.canAccess(principal, params.projectId, "viewer"))) return error(reply, 403, "forbidden", "Project access denied");
    const body = request.body as { revision?: unknown };
    if (!Number.isSafeInteger(body?.revision) || (body.revision as number) < 1) return error(reply, 400, "invalid_request", "revision must be a positive integer");
    const revision = await dependencies.revisions.get(params.projectId, body.revision as number);
    if (!revision) return error(reply, 404, "not_found", "Revision not found");
    return { format: "otio", document: exportOtio(revision.timeline, (await dependencies.projects.get(params.projectId))?.name ?? "VideoCraft timeline") };
  });
  server.post("/v1/projects/:projectId/timeline/import", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string };
    if (!params.projectId || !(await dependencies.authorize.canAccess(principal, params.projectId, "editor"))) return error(reply, 403, "forbidden", "Project access denied");
    try {
      const body = request.body as { document?: unknown };
      const timeline = importOtio(body?.document);
      const revision = await dependencies.saveRevision({ projectId: params.projectId, createdBy: principal.userId, timeline, acceptedProposalIds: [] });
      return reply.code(201).send({ revision });
    } catch (caught) {
      return error(reply, 400, "invalid_otio", caught instanceof Error ? caught.message : "Invalid OTIO document");
    }
  });
}
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
