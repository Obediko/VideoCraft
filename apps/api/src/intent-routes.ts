import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IntentAnalysisPort, TranscriptSegment, UUID } from "@videocraft/domain";

export interface IntentRouteDependencies {
  analyzer: IntentAnalysisPort;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, role: "viewer" | "editor"): Promise<boolean> };
  assets?: { listForProject(projectId: UUID): Promise<Array<{ id: UUID }>> };
  transcripts?: { listForAsset(assetId: UUID): Promise<TranscriptSegment[]> };
  providerRateLimitMax?: number;
}
export function registerIntentRoutes(server: FastifyInstance, dependencies: IntentRouteDependencies): void {
  server.post("/v1/projects/:projectId/intent/analyze", { config: { rateLimit: { max: dependencies.providerRateLimitMax ?? 20, timeWindow: "1 minute" } } } as any, async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string };
    if (!params.projectId) return error(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, params.projectId, "viewer"))) return error(reply, 403, "forbidden", "Project access denied");
    const body = request.body as { prompt?: unknown; includeTranscript?: unknown };
    if (typeof body?.prompt !== "string") return error(reply, 400, "invalid_request", "prompt is required");
    let transcript: TranscriptSegment[] = [];
    if (body.includeTranscript === true && dependencies.assets && dependencies.transcripts) {
      try {
        const assets = await dependencies.assets.listForProject(params.projectId);
        const segments = await Promise.all(assets.map((asset) => dependencies.transcripts!.listForAsset(asset.id)));
        transcript = segments.flat();
      } catch (caught) {
        return error(reply, 503, "transcript_unavailable", caught instanceof Error ? caught.message : "Project transcript is unavailable");
      }
    }
    try {
      return { analysis: await dependencies.analyzer.analyze({ prompt: body.prompt, transcript }) };
    } catch (caught) {
      return error(reply, 400, "invalid_request", caught instanceof Error ? caught.message : "Intent analysis failed");
    }
  });
}
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
