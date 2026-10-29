import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Asset, UUID } from "@videocraft/domain";
import type { AssetRepository } from "@videocraft/application";
import type { ObjectStorage } from "@videocraft/storage";
import { validateMedia, type MediaInfo } from "@videocraft/analysis";

/**
 * Free stock media for cutaways: Pexels and Pixabay (videos and photos) and Giphy (GIFs, imported as silent
 * MP4 clips). Searches run on the server with the keys in the environment; a source without a key is skipped.
 * Importing fetches the item again by id from the provider (never a URL from the browser), downloads it from the
 * provider's own media hosts and stores it as an ordinary project asset with its credit.
 */
export type StockKind = "video" | "photo" | "gif";
export type StockProvider = "pexels" | "pixabay" | "giphy";
export interface StockItem {
  provider: StockProvider; id: string; kind: StockKind;
  thumbUrl: string; previewUrl?: string | undefined; width: number; height: number; durationS?: number | undefined;
  title?: string | undefined; credit?: string | undefined; pageUrl?: string | undefined;
}
interface Rendition { url: string; width: number; height: number; mimeType: string; extension: string }
export interface StockKeys { pexels?: string; pixabay?: string; giphy?: string }
export type Fetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "follow" | "manual" }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; body: ReadableStream<Uint8Array> | null; headers: { get(name: string): string | null } }>;

/** Media hosts downloads may come from; anything else is refused. */
const MEDIA_HOSTS = [/(^|\.)pexels\.com$/, /(^|\.)vimeo\.com$/, /(^|\.)vimeocdn\.com$/, /(^|\.)pixabay\.com$/, /(^|\.)giphy\.com$/];
const MAX_BYTES = 300 * 1024 * 1024;

export function providersFor(keys: StockKeys, kind: StockKind): StockProvider[] {
  if (kind === "gif") return keys.giphy ? ["giphy"] : [];
  return [...(keys.pexels ? ["pexels" as const] : []), ...(keys.pixabay ? ["pixabay" as const] : [])];
}

type Json = Record<string, any>;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

async function getJson(fetcher: Fetcher, url: string, headers: Record<string, string> = {}): Promise<Json> {
  const response = await fetcher(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new StockError(response.status === 429 ? 429 : 502, response.status === 429 ? "The stock library is busy; try again in a minute" : "The stock library did not answer (" + response.status + ")");
  return (await response.json()) as Json;
}

export class StockError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Search one provider; results are normalised. */
export async function searchProvider(fetcher: Fetcher, keys: StockKeys, provider: StockProvider, kind: StockKind, query: string, orientation?: "portrait" | "landscape" | "square"): Promise<StockItem[]> {
  const q = encodeURIComponent(query);
  if (provider === "pexels") {
    const o = orientation ? "&orientation=" + orientation : "";
    if (kind === "video") {
      const data = await getJson(fetcher, "https://api.pexels.com/videos/search?per_page=15&query=" + q + o, { authorization: keys.pexels! });
      return (Array.isArray(data.videos) ? data.videos : []).map((v: Json) => ({ provider, id: String(v.id), kind, thumbUrl: str(v.image) ?? "", previewUrl: str(pexelsVideoFile(v, 640)?.link), width: num(v.width), height: num(v.height), durationS: num(v.duration), credit: str(v.user?.name), pageUrl: str(v.url) }));
    }
    const data = await getJson(fetcher, "https://api.pexels.com/v1/search?per_page=15&query=" + q + o, { authorization: keys.pexels! });
    return (Array.isArray(data.photos) ? data.photos : []).map((p: Json) => ({ provider, id: String(p.id), kind, thumbUrl: str(p.src?.medium) ?? str(p.src?.small) ?? "", width: num(p.width), height: num(p.height), title: str(p.alt), credit: str(p.photographer), pageUrl: str(p.url) }));
  }
  if (provider === "pixabay") {
    const o = orientation === "portrait" ? "&orientation=vertical" : orientation === "landscape" ? "&orientation=horizontal" : "";
    if (kind === "video") {
      const data = await getJson(fetcher, "https://pixabay.com/api/videos/?safesearch=true&per_page=15&key=" + encodeURIComponent(keys.pixabay!) + "&q=" + q);
      return (Array.isArray(data.hits) ? data.hits : []).map((v: Json) => ({ provider, id: String(v.id), kind, thumbUrl: str(v.videos?.tiny?.thumbnail) ?? str(v.videos?.small?.thumbnail) ?? "", previewUrl: str(v.videos?.tiny?.url), width: num(v.videos?.large?.width ?? v.videos?.medium?.width), height: num(v.videos?.large?.height ?? v.videos?.medium?.height), durationS: num(v.duration), title: str(v.tags), credit: str(v.user), pageUrl: str(v.pageURL) }));
    }
    const data = await getJson(fetcher, "https://pixabay.com/api/?safesearch=true&image_type=photo&per_page=15&key=" + encodeURIComponent(keys.pixabay!) + "&q=" + q + o);
    return (Array.isArray(data.hits) ? data.hits : []).map((p: Json) => ({ provider, id: String(p.id), kind, thumbUrl: str(p.webformatURL) ?? str(p.previewURL) ?? "", width: num(p.imageWidth), height: num(p.imageHeight), title: str(p.tags), credit: str(p.user), pageUrl: str(p.pageURL) }));
  }
  const data = await getJson(fetcher, "https://api.giphy.com/v1/gifs/search?limit=15&rating=g&api_key=" + encodeURIComponent(keys.giphy!) + "&q=" + q);
  return (Array.isArray(data.data) ? data.data : []).map((g: Json) => ({ provider, id: String(g.id), kind, thumbUrl: str(g.images?.fixed_width?.webp) ?? str(g.images?.fixed_width?.url) ?? "", previewUrl: str(g.images?.fixed_width?.mp4), width: num(Number(g.images?.original?.width)), height: num(Number(g.images?.original?.height)), title: str(g.title), credit: str(g.username) || undefined, pageUrl: str(g.url) }));
}

function pexelsVideoFile(video: Json, target: number): Json | undefined {
  const files: Json[] = (Array.isArray(video.video_files) ? video.video_files : []).filter((f: Json) => f.file_type === "video/mp4" && typeof f.link === "string" && num(f.width) > 0);
  const side = (f: Json) => Math.max(num(f.width), num(f.height));
  // The smallest file at least `target` on its long side, else the largest below it.
  return files.filter((f) => side(f) >= target).sort((a, b) => side(a) - side(b))[0] ?? files.sort((a, b) => side(b) - side(a))[0];
}

/** Looks the item up again by id and picks the file to import (up to about 1080p for video, a large photo). */
export async function resolveRendition(fetcher: Fetcher, keys: StockKeys, provider: StockProvider, kind: StockKind, id: string): Promise<{ rendition: Rendition; item: StockItem }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new StockError(400, "Invalid stock id");
  if (!providersFor(keys, kind).includes(provider)) throw new StockError(503, "This stock library is not set up on the server");
  if (provider === "pexels") {
    if (kind === "video") {
      const v = await getJson(fetcher, "https://api.pexels.com/videos/videos/" + id, { authorization: keys.pexels! });
      const file = pexelsVideoFile(v, 1920);
      if (!file) throw new StockError(404, "No downloadable file for this video");
      return { rendition: { url: file.link, width: num(file.width), height: num(file.height), mimeType: "video/mp4", extension: "mp4" }, item: { provider, id, kind, thumbUrl: str(v.image) ?? "", width: num(v.width), height: num(v.height), durationS: num(v.duration), credit: str(v.user?.name), pageUrl: str(v.url) } };
    }
    const p = await getJson(fetcher, "https://api.pexels.com/v1/photos/" + id, { authorization: keys.pexels! });
    const url = str(p.src?.large2x) ?? str(p.src?.original);
    if (!url) throw new StockError(404, "No downloadable file for this photo");
    return { rendition: { url, width: num(p.width), height: num(p.height), mimeType: "image/jpeg", extension: "jpg" }, item: { provider, id, kind, thumbUrl: str(p.src?.medium) ?? "", width: num(p.width), height: num(p.height), credit: str(p.photographer), pageUrl: str(p.url) } };
  }
  if (provider === "pixabay") {
    if (kind === "video") {
      const data = await getJson(fetcher, "https://pixabay.com/api/videos/?key=" + encodeURIComponent(keys.pixabay!) + "&id=" + id);
      const v: Json | undefined = data.hits?.[0];
      const file = v && ([v.videos?.large, v.videos?.medium, v.videos?.small].find((f: Json | undefined) => f && typeof f.url === "string" && f.url && num(f.width) > 0 && num(f.width) <= 1920) as Json | undefined);
      if (!v || !file) throw new StockError(404, "No downloadable file for this video");
      return { rendition: { url: file.url, width: num(file.width), height: num(file.height), mimeType: "video/mp4", extension: "mp4" }, item: { provider, id, kind, thumbUrl: str(file.thumbnail) ?? "", width: num(file.width), height: num(file.height), durationS: num(v.duration), credit: str(v.user), pageUrl: str(v.pageURL) } };
    }
    const data = await getJson(fetcher, "https://pixabay.com/api/?key=" + encodeURIComponent(keys.pixabay!) + "&id=" + id);
    const p: Json | undefined = data.hits?.[0];
    const url = p && (str(p.largeImageURL) ?? str(p.webformatURL));
    if (!p || !url) throw new StockError(404, "No downloadable file for this photo");
    return { rendition: { url, width: num(p.imageWidth), height: num(p.imageHeight), mimeType: "image/jpeg", extension: "jpg" }, item: { provider, id, kind, thumbUrl: str(p.webformatURL) ?? "", width: num(p.imageWidth), height: num(p.imageHeight), credit: str(p.user), pageUrl: str(p.pageURL) } };
  }
  const data = await getJson(fetcher, "https://api.giphy.com/v1/gifs/" + id + "?api_key=" + encodeURIComponent(keys.giphy!));
  const g: Json | undefined = data.data;
  const original = g?.images?.original;
  if (!g || typeof original?.mp4 !== "string") throw new StockError(404, "No downloadable file for this GIF");
  return { rendition: { url: original.mp4, width: num(Number(original.width)), height: num(Number(original.height)), mimeType: "video/mp4", extension: "mp4" }, item: { provider, id, kind, thumbUrl: str(g.images?.fixed_width?.url) ?? "", width: num(Number(original.width)), height: num(Number(original.height)), title: str(g.title), credit: str(g.username) || undefined, pageUrl: str(g.url) } };
}

export function allowedMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && (parsed.port === "" || parsed.port === "443") && MEDIA_HOSTS.some((host) => host.test(parsed.hostname));
  } catch { return false; }
}

async function download(fetcher: Fetcher, url: string, path: string): Promise<void> {
  // Redirects are followed by hand so every hop stays on the libraries' own media hosts.
  const signal = AbortSignal.timeout(120_000);
  let response: Awaited<ReturnType<Fetcher>> | undefined;
  for (let hop = 0; hop < 5; hop += 1) {
    if (!allowedMediaUrl(url)) throw new StockError(502, "The stock file is on an unexpected host");
    response = await fetcher(url, { signal, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) throw new StockError(502, "The stock file could not be downloaded (" + response.status + ")");
    url = new URL(location, url).toString();
    response = undefined;
  }
  if (!response) throw new StockError(502, "Too many redirects for the stock file");
  if (!response.ok || !response.body) throw new StockError(502, "The stock file could not be downloaded (" + response.status + ")");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new StockError(413, "The stock file is too large");
  let received = 0;
  const limited = Readable.fromWeb(response.body as never).on("data", (chunk: Buffer) => { received += chunk.length; if (received > MAX_BYTES) limited.destroy(new StockError(413, "The stock file is too large")); });
  await pipeline(limited, createWriteStream(path, { flags: "wx" }));
}

export interface StockDependencies {
  keys: StockKeys;
  fetch?: Fetcher;
  assets: AssetRepository;
  storage: ObjectStorage;
  inspector?: (path: string) => Promise<MediaInfo>;
  imageInspector?: (path: string) => Promise<boolean>;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, minimumRole: "viewer" | "editor"): Promise<boolean> };
  clock(): string;
}

export function registerStockRoutes(server: FastifyInstance, dependencies: StockDependencies): void {
  const fetcher: Fetcher = dependencies.fetch ?? ((url, init) => fetch(url, init) as never);
  const guard = async (request: FastifyRequest, reply: FastifyReply, role: "viewer" | "editor"): Promise<string | undefined> => {
    const principal = await dependencies.authenticate(request);
    if (!principal) { error(reply, 401, "unauthorized", "Authentication required"); return undefined; }
    const projectId = (request.params as { projectId?: string }).projectId;
    if (!projectId || !(await dependencies.authorize.canAccess(principal, projectId, role))) { error(reply, 403, "forbidden", "Project access denied"); return undefined; }
    return projectId;
  };

  /** Which libraries are set up, so the editor only offers what works. */
  server.get("/v1/projects/:projectId/stock/sources", async (request, reply) => {
    if (!(await guard(request, reply, "viewer"))) return reply;
    return { video: providersFor(dependencies.keys, "video"), photo: providersFor(dependencies.keys, "photo"), gif: providersFor(dependencies.keys, "gif") };
  });

  server.get("/v1/projects/:projectId/stock/search", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } } as any, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await guard(request, reply, "editor"))) return reply;
    const query = request.query as { q?: string; kind?: string; orientation?: string };
    const q = (query.q ?? "").trim().slice(0, 100);
    const kind = query.kind === "photo" || query.kind === "gif" ? query.kind : "video";
    const orientation = query.orientation === "portrait" || query.orientation === "landscape" || query.orientation === "square" ? query.orientation : undefined;
    if (!q) return error(reply, 400, "invalid_request", "Type what to look for");
    const providers = providersFor(dependencies.keys, kind);
    if (providers.length === 0) return error(reply, 503, "stock_unavailable", kind === "gif" ? "GIF search needs a Giphy key on the server" : "Stock search needs a Pexels or Pixabay key on the server");
    const settled = await Promise.allSettled(providers.map((provider) => searchProvider(fetcher, dependencies.keys, provider, kind, q, orientation)));
    const lists = settled.map((result) => (result.status === "fulfilled" ? result.value.filter((item) => item.thumbUrl) : []));
    if (settled.every((result) => result.status === "rejected")) {
      const reason = (settled[0] as PromiseRejectedResult).reason;
      return error(reply, reason instanceof StockError ? reason.status : 502, "stock_failed", reason instanceof Error ? reason.message : "Stock search failed");
    }
    // Interleave the libraries so both show near the top.
    const items: StockItem[] = [];
    for (let i = 0; i < Math.max(0, ...lists.map((list) => list.length)); i += 1) for (const list of lists) if (list[i]) items.push(list[i]!);
    return { items };
  });

  server.post("/v1/projects/:projectId/stock/import", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } } as any, async (request: FastifyRequest, reply: FastifyReply) => {
    const projectId = await guard(request, reply, "editor");
    if (!projectId) return reply;
    const body = (request.body ?? {}) as { provider?: string; kind?: string; id?: string };
    const provider = body.provider === "pexels" || body.provider === "pixabay" || body.provider === "giphy" ? body.provider : undefined;
    const kind = body.kind === "video" || body.kind === "photo" || body.kind === "gif" ? body.kind : undefined;
    if (!provider || !kind || typeof body.id !== "string") return error(reply, 400, "invalid_request", "provider, kind and id are required");
    // The same item imported twice is the same asset.
    const existing = (await dependencies.assets.listForProject(projectId)).find((asset) => asset.metadata.stockProvider === provider && asset.metadata.stockId === body.id && asset.metadata.stockKind === kind);
    if (existing) return { asset: existing };
    const assetId = randomUUID();
    const directory = join(tmpdir(), "videocraft-stock", assetId);
    try {
      const { rendition, item } = await resolveRendition(fetcher, dependencies.keys, provider, kind, body.id);
      await mkdir(directory, { recursive: true });
      const path = join(directory, "download." + rendition.extension);
      await download(fetcher, rendition.url, path);
      const assetKind: Asset["kind"] = kind === "photo" ? "image" : "video";
      let info: MediaInfo | undefined;
      if (assetKind === "video" && dependencies.inspector) { info = await dependencies.inspector(path); validateMedia(info); if (!info.hasVideo) throw new StockError(422, "The stock file has no picture"); }
      if (assetKind === "image" && dependencies.imageInspector && !(await dependencies.imageInspector(path))) throw new StockError(422, "The stock file is not an image");
      const storageKey = "projects/" + projectId + "/assets/" + assetId + ".media";
      const stored = await dependencies.storage.putFile(path, storageKey);
      const label = kind === "gif" ? "GIF" : kind === "photo" ? "Photo" : "Video";
      const libraryName = provider === "pexels" ? "Pexels" : provider === "pixabay" ? "Pixabay" : "GIPHY";
      const asset: Asset = {
        id: assetId, projectId, kind: assetKind, storageKey: stored.key, checksumSha256: stored.checksumSha256,
        ...(info ? { durationUs: info.durationUs } : {}),
        metadata: {
          filename: (label + " · " + (item.title?.split(",")[0]?.trim() || libraryName) + "." + rendition.extension).slice(0, 255), mimeType: rendition.mimeType,
          stockProvider: provider, stockKind: kind, stockId: body.id,
          credit: ((item.credit ? item.credit + " on " : "") + libraryName).slice(0, 200),
          ...(item.pageUrl ? { sourceUrl: item.pageUrl.slice(0, 500) } : {}),
          ...(info ? { hasVideo: info.hasVideo, hasAudio: info.hasAudio, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) } : { width: rendition.width, height: rendition.height }),
        },
        createdAt: dependencies.clock(),
      };
      try { await dependencies.assets.save(asset); }
      catch (caught) { await dependencies.storage.remove(storageKey).catch(() => undefined); throw caught; }
      return reply.code(201).send({ asset });
    } catch (caught) {
      if (caught instanceof StockError) return error(reply, caught.status, "stock_failed", caught.message);
      request.log.warn({ err: caught }, "stock import failed");
      return error(reply, 502, "stock_failed", "The stock file could not be imported");
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
