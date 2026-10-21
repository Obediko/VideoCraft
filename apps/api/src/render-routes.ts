import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RenderJobRepository, UUID } from "@videocraft/domain";

export interface RenderRouteDependencies {
  jobs: RenderJobRepository;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, role: "viewer" | "editor"): Promise<boolean> };
}
export function registerRenderRoutes(server: FastifyInstance, dependencies: RenderRouteDependencies): void {
  server.get("/v1/projects/:projectId/renders/:renderId", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string; renderId?: string };
    if (!params.projectId || !params.renderId) return error(reply, 400, "invalid_request", "projectId and renderId are required");
    if (!(await dependencies.authorize.canAccess(principal, params.projectId, "viewer"))) return error(reply, 403, "forbidden", "Project access denied");
    const job = await dependencies.jobs.get(params.renderId);
    if (!job || job.projectId !== params.projectId) return error(reply, 404, "not_found", "Render job not found");
    return { job };
  });
  server.post("/v1/projects/:projectId/renders/:renderId/cancel", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string; renderId?: string };
    if (!params.projectId || !params.renderId) return error(reply, 400, "invalid_request", "projectId and renderId are required");
    if (!(await dependencies.authorize.canAccess(principal, params.projectId, "editor"))) return error(reply, 403, "forbidden", "Project access denied");
    const job = await dependencies.jobs.get(params.renderId);
    if (!job || job.projectId !== params.projectId) return error(reply, 404, "not_found", "Render job not found");
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") return error(reply, 409, "render_state", "Render job is already terminal");
    const cancelled = { ...job, status: "cancelled" as const, progress: Math.min(job.progress, 99) };
    await dependencies.jobs.update(cancelled);
    return { job: cancelled };
  });
}
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
