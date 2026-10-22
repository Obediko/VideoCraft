import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RenderJobRepository, UUID } from "@videocraft/domain";
import type { ObjectStorage } from "@videocraft/storage";
import { sendRanged } from "./media-routes.js";

export interface RenderRouteDependencies {
  jobs: RenderJobRepository; storage: ObjectStorage; signingSecret: string;
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
  server.get("/v1/projects/:projectId/renders/:renderId/download-url", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string; renderId?: string };
    if (!params.projectId || !params.renderId) return error(reply, 400, "invalid_request", "projectId and renderId are required");
    if (!(await dependencies.authorize.canAccess(principal, params.projectId, "viewer"))) return error(reply, 403, "forbidden", "Project access denied");
    const job = await dependencies.jobs.get(params.renderId);
    const output = job ? projectOutput(job, params.projectId) : undefined;
    if (!job || !output || job.status !== "succeeded") return error(reply, 404, "not_found", "Completed render output not found");
    if (dependencies.storage.createDownloadUrl) return { url: await dependencies.storage.createDownloadUrl(output.storageKey, 300), expires: Math.floor(Date.now() / 1000) + 300, providerNative: true };
    const expires = Math.floor(Date.now() / 1000) + 300;
    const signature = sign(params.projectId + ":" + params.renderId + ":" + output.storageKey + ":" + expires, dependencies.signingSecret);
    return { url: "/v1/projects/" + params.projectId + "/renders/" + params.renderId + "/download?expires=" + expires + "&signature=" + signature, expires, providerNative: false };
  });
  server.get("/v1/projects/:projectId/renders/:renderId/download", async (request, reply) => {
    const params = request.params as { projectId?: string; renderId?: string };
    if (!params.projectId || !params.renderId) return error(reply, 400, "invalid_request", "projectId and renderId are required");
    const job = await dependencies.jobs.get(params.renderId);
    const output = job ? projectOutput(job, params.projectId) : undefined;
    if (!job || !output || job.status !== "succeeded") return error(reply, 404, "not_found", "Completed render output not found");
    const query = request.query as { expires?: string; signature?: string };
    const signed = typeof query.expires === "string" && typeof query.signature === "string" && Number.isSafeInteger(Number(query.expires)) && Number(query.expires) >= Math.floor(Date.now() / 1000) && verify(params.projectId + ":" + params.renderId + ":" + output.storageKey + ":" + query.expires, query.signature, dependencies.signingSecret);
    if (!signed) return error(reply, 401, "invalid_download_signature", "Download URL is missing or expired");
    return sendRanged(request, reply, dependencies.storage.resolve(output.storageKey), output.mimeType);
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
function sign(value: string, secret: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
function verify(value: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(value, secret)); const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function projectOutput(job: { projectId: string; output?: { storageKey: string; mimeType: string } }, projectId: string): { storageKey: string; mimeType: string } | undefined {
  if (job.projectId !== projectId || !job.output?.storageKey.startsWith("projects/" + projectId + "/renders/")) return undefined;
  return job.output;
}
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
