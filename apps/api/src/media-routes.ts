import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UUID } from "@videocraft/domain";
import type { ObjectStorage } from "@videocraft/storage";

/** Streams a local file honouring HTTP Range, which browsers need to seek inside video. */
export async function sendRanged(request: FastifyRequest, reply: FastifyReply, path: string, mimeType: string): Promise<FastifyReply> {
  const { size } = await stat(path);
  reply.header("Accept-Ranges", "bytes").type(mimeType);
  const header = request.headers.range;
  if (!header) return reply.header("Content-Length", size).send(createReadStream(path));
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return reply.code(416).header("Content-Range", "bytes */" + size).send();
  let start: number;
  let end: number;
  if (match[1] === "") { const suffix = Number(match[2]); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1); }
  if (!(start <= end) || start >= size) return reply.code(416).header("Content-Range", "bytes */" + size).send();
  return reply.code(206).header("Content-Range", "bytes " + start + "-" + end + "/" + size).header("Content-Length", end - start + 1).send(createReadStream(path, { start, end }));
}

export interface MediaRouteDependencies {
  assets: { listForProject(projectId: UUID): Promise<Array<{ id: UUID; storageKey: string; kind: string; metadata: Record<string, unknown> }>> };
  storage: ObjectStorage; signingSecret: string;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, role: "viewer" | "editor"): Promise<boolean> };
}

const MIME_BY_EXTENSION: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

/** Signed, range-capable playback of the original uploaded media, so the editor can scrub the source. */
export function registerMediaRoutes(server: FastifyInstance, dependencies: MediaRouteDependencies): void {
  const find = async (projectId: string, assetId: string) => {
    const asset = (await dependencies.assets.listForProject(projectId)).find((candidate) => candidate.id === assetId);
    return asset && asset.storageKey.startsWith("projects/" + projectId + "/") ? asset : undefined;
  };
  server.get("/v1/projects/:projectId/assets/:assetId/playback-url", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const params = request.params as { projectId?: string; assetId?: string };
    if (!params.projectId || !params.assetId) return error(reply, 400, "invalid_request", "projectId and assetId are required");
    if (!(await dependencies.authorize.canAccess(principal, params.projectId, "viewer"))) return error(reply, 403, "forbidden", "Project access denied");
    const asset = await find(params.projectId, params.assetId);
    if (!asset) return error(reply, 404, "not_found", "Asset not found");
    // Formats browsers cannot play are previewed through a generated proxy; until it is ready the client waits.
    if (asset.metadata.proxyStatus === "pending") return reply.code(202).send({ pending: true, retryAfterSeconds: 5 });
    const playable = playbackKey(asset);
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const proxy = playable !== asset.storageKey;
    if (dependencies.storage.createDownloadUrl) return { url: await dependencies.storage.createDownloadUrl(playable, 3600), expires, providerNative: true, proxy };
    const signature = sign(params.projectId + ":" + asset.id + ":" + playable + ":" + expires, dependencies.signingSecret);
    return { url: "/v1/projects/" + params.projectId + "/assets/" + asset.id + "/media?expires=" + expires + "&signature=" + signature, expires, providerNative: false, proxy };
  });
  server.get("/v1/projects/:projectId/assets/:assetId/media", async (request, reply) => {
    const params = request.params as { projectId?: string; assetId?: string };
    if (!params.projectId || !params.assetId) return error(reply, 400, "invalid_request", "projectId and assetId are required");
    const asset = await find(params.projectId, params.assetId);
    if (!asset) return error(reply, 404, "not_found", "Asset not found");
    const query = request.query as { expires?: string; signature?: string };
    const signed = typeof query.expires === "string" && typeof query.signature === "string" && Number.isSafeInteger(Number(query.expires)) && Number(query.expires) >= Math.floor(Date.now() / 1000)
      && verify(params.projectId + ":" + asset.id + ":" + playbackKey(asset) + ":" + query.expires, query.signature, dependencies.signingSecret);
    if (!signed) return error(reply, 401, "invalid_download_signature", "Playback URL is missing or expired");
    const key = playbackKey(asset);
    return sendRanged(request, reply, dependencies.storage.resolve(key), mimeOf(asset, key));
  });
}

function playbackKey(asset: { storageKey: string; metadata: Record<string, unknown> }): string {
  const proxyKey = asset.metadata.proxyKey;
  return asset.metadata.proxyStatus === "ready" && typeof proxyKey === "string" && proxyKey.startsWith(asset.storageKey.slice(0, asset.storageKey.lastIndexOf("/") + 1)) ? proxyKey : asset.storageKey;
}
/** Uploads are stored as ".media", so the type comes from the upload's declared type, then the original filename. */
function mimeOf(asset: { storageKey: string; metadata: Record<string, unknown> }, key: string): string {
  if (key.endsWith(".proxy.mp4")) return "video/mp4";
  const declared = asset.metadata.mimeType;
  if (typeof declared === "string" && /^(video|audio|image)\/[\w.+-]+$/.test(declared)) return declared;
  const name = typeof asset.metadata.filename === "string" ? asset.metadata.filename : key;
  return MIME_BY_EXTENSION[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

function sign(value: string, secret: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
function verify(value: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(value, secret)); const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
