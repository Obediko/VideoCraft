import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IntentAnalysisPort, UUID } from "@videocraft/domain";

export interface IntentRouteDependencies {
  analyzer: IntentAnalysisPort;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, role: "viewer" | "editor"): Promise<boolean> };
}
export function registerIntentRoutes(server: FastifyInstance, dependencies: IntentRouteDependencies): void {
  server.post({ url: "/v1/projects/:projectId/intent/analyze", config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string };
    if (!params.projectId) return error(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, params.projectId, "viewer"))) return error(reply, 403, "forbidden", "Project access denied");
    const body = request.body as { prompt?: unknown; transcript?: unknown };
    if (typeof body?.prompt !== "string") return error(reply, 400, "invalid_request", "prompt is required");
    try {
      return { analysis: await dependencies.analyzer.analyze({ prompt: body.prompt }) };
    } catch (caught) {
      return error(reply, 400, "invalid_request", caught instanceof Error ? caught.message : "Intent analysis failed");
    }
  });
}
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
