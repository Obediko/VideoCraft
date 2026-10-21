import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FeedbackEvent, FeedbackRepository, UUID } from "@videocraft/domain";

export interface FeedbackRouteDependencies {
  feedback: FeedbackRepository;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, role: "viewer" | "editor"): Promise<boolean> };
  now(): string;
}
export function registerFeedbackRoutes(server: FastifyInstance, dependencies: FeedbackRouteDependencies): void {
  server.post("/v1/projects/:projectId/feedback", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string };
    if (!params.projectId) return error(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, params.projectId, "editor"))) return error(reply, 403, "forbidden", "Project access denied");
    const body = request.body as Record<string, unknown>;
    if (!Number.isSafeInteger(body?.revision) || (body.revision as number) < 1 || !isType(body?.type)) {
      return error(reply, 400, "invalid_request", "revision and a valid feedback type are required");
    }
    if (body.value !== undefined && (typeof body.value !== "number" || !Number.isFinite(body.value))) return error(reply, 400, "invalid_request", "value must be finite");
    if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2_000)) return error(reply, 400, "invalid_request", "note must be at most 2,000 characters");
    const event: FeedbackEvent = {
      id: randomUUID(), projectId: params.projectId, revision: body.revision as number, type: body.type,
      ...(typeof body.strategyId === "string" ? { strategyId: body.strategyId } : {}),
      ...(typeof body.proposalId === "string" ? { proposalId: body.proposalId } : {}),
      ...(typeof body.value === "number" ? { value: body.value } : {}),
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      createdAt: dependencies.now(),
    };
    await dependencies.feedback.append(event);
    return reply.code(201).send({ event });
  });
}
function isType(value: unknown): value is FeedbackEvent["type"] { return value === "accepted" || value === "rejected" || value === "edited" || value === "exported" || value === "shared"; }
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
