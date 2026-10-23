import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { applyTimelineOperations, parseTimelineOperations, type PreferenceRepository, type ProjectRevision, type UUID } from "@videocraft/domain";
import { record, removedSamples } from "./learning.js";
import { exportOtio, importOtio } from "@videocraft/timeline-interchange";
import type { AssetRepository, ProjectRepository, RevisionRepository } from "@videocraft/application";

export interface TimelineRouteDependencies {
  projects: ProjectRepository; revisions: RevisionRepository;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, role: "viewer" | "editor"): Promise<boolean> };
  /** When present, clips the person removes teach the highlight strategy. */
  preferences?: PreferenceRepository;
  /** When present, operations may only reference this project's assets, of a kind that fits the operation. */
  assets?: Pick<AssetRepository, "listForProject">;
  saveRevision(input: { projectId: UUID; createdBy: UUID; timeline: ProjectRevision["timeline"]; acceptedProposalIds: UUID[]; tailoring?: NonNullable<ProjectRevision["tailoring"]> }): Promise<ProjectRevision>;
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
  /**
   * Applies editor operations (trim, split, remove, insert, reorder, caption corrections) to a
   * stored revision and saves the result as a new revision. The base revision is never mutated.
   */
  server.post("/v1/projects/:projectId/revisions/:revision/edit", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string; revision?: string };
    if (!params.projectId || !(await dependencies.authorize.canAccess(principal, params.projectId, "editor"))) return error(reply, 403, "forbidden", "Project access denied");
    if (!params.revision || !/^\d+$/.test(params.revision) || Number(params.revision) < 1) return error(reply, 400, "invalid_request", "revision must be a positive integer");
    const base = await dependencies.revisions.get(params.projectId, Number(params.revision));
    if (!base) return error(reply, 404, "not_found", "Revision not found");
    const project = await dependencies.projects.get(params.projectId);
    if (project && project.revision !== base.revision) return error(reply, 409, "revision_conflict", "Revision " + project.revision + " is newer; reload before editing");
    try {
      const operations = parseTimelineOperations((request.body as { operations?: unknown } | undefined)?.operations);
      if (dependencies.assets) {
        const owned = new Map((await dependencies.assets.listForProject(params.projectId)).map((asset) => [asset.id, asset.kind]));
        for (const operation of operations) {
          if (operation.type === "insert-clip" && owned.get(operation.assetId) !== "video") return error(reply, 400, "invalid_edit", "insert-clip must reference a video asset in this project");
          if (operation.type === "add-broll" && owned.get(operation.assetId) !== "video" && owned.get(operation.assetId) !== "image") return error(reply, 400, "invalid_edit", "add-broll must reference a video or image asset in this project");
          if (operation.type === "add-broll" && owned.get(operation.anchorAssetId) !== "video") return error(reply, 400, "invalid_edit", "add-broll must be anchored to a video asset in this project");
          if (operation.type === "set-music" && owned.get(operation.assetId) !== "audio" && owned.get(operation.assetId) !== "video") return error(reply, 400, "invalid_edit", "set-music must reference an audio or video asset in this project");
        }
      }
      const revision = await dependencies.saveRevision({
        projectId: params.projectId,
        createdBy: principal.userId,
        timeline: applyTimelineOperations(base.timeline, operations),
        acceptedProposalIds: base.acceptedProposalIds,
        ...(base.tailoring === undefined ? {} : { tailoring: base.tailoring }),
      });
      const removed = operations.flatMap((operation) => operation.type === "remove-clip" ? [operation.clipId] : []);
      await record(dependencies.preferences, removedSamples(principal.userId, params.projectId, base.revision, base.timeline, removed, new Date().toISOString()), (caught) => request.log.warn({ err: caught }, "Could not record preference samples"));
      return reply.code(201).send({ revision });
    } catch (caught) {
      return error(reply, 400, "invalid_edit", caught instanceof Error ? caught.message : "Invalid edit");
    }
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
