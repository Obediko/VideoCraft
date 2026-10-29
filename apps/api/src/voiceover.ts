import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Asset, UUID } from "@videocraft/domain";
import type { AssetRepository } from "@videocraft/application";
import type { ObjectStorage } from "@videocraft/storage";
import type { MediaInfo } from "@videocraft/analysis";

/**
 * Voice-over from typed text with OpenAI's text-to-speech voices (the account's own API key). Recordings made in
 * the browser go through the ordinary upload route; both become audio assets placed with add-voiceover.
 */
export const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] as const;
type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;

export interface VoiceoverDependencies {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  fetch?: Fetcher;
  assets: AssetRepository;
  storage: ObjectStorage;
  inspector?: (path: string) => Promise<MediaInfo>;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, minimumRole: "viewer" | "editor"): Promise<boolean> };
  clock(): string;
}

export function registerVoiceoverRoutes(server: FastifyInstance, dependencies: VoiceoverDependencies): void {
  const fetcher: Fetcher = dependencies.fetch ?? ((url, init) => fetch(url, init) as never);
  server.get("/v1/projects/:projectId/voiceover/voices", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    return { voices: dependencies.apiKey ? VOICES : [] };
  });
  server.post("/v1/projects/:projectId/voiceover/speech", { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } } as any, async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const projectId = (request.params as { projectId?: string }).projectId;
    if (!projectId || !(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return error(reply, 403, "forbidden", "Project access denied");
    if (!dependencies.apiKey) return error(reply, 503, "voice_unavailable", "Typed voice-over needs the OpenAI key on the server; you can still record your own");
    const body = (request.body ?? {}) as { text?: unknown; voice?: unknown; style?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 3000) return error(reply, 400, "invalid_request", "Type up to 3000 characters to read out");
    const voice = typeof body.voice === "string" && (VOICES as readonly string[]).includes(body.voice) ? body.voice : "alloy";
    const style = typeof body.style === "string" ? body.style.trim().slice(0, 200) : "";
    const response = await fetcher((dependencies.endpoint ?? "https://api.openai.com/v1") + "/audio/speech", {
      method: "POST", signal: AbortSignal.timeout(90_000),
      headers: { authorization: "Bearer " + dependencies.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ model: dependencies.model ?? "gpt-4o-mini-tts", voice, input: text, response_format: "mp3", ...(style ? { instructions: style } : {}) }),
    }).catch(() => undefined);
    if (!response || !response.ok) return error(reply, 502, "voice_failed", response?.status === 429 ? "The voice service is busy; try again in a minute" : "The voice could not be made");
    const assetId = randomUUID();
    const directory = join(tmpdir(), "videocraft-voice", assetId);
    try {
      await mkdir(directory, { recursive: true });
      const path = join(directory, "voice.mp3");
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
      const info = dependencies.inspector ? await dependencies.inspector(path) : undefined;
      if (info && !info.hasAudio) return error(reply, 502, "voice_failed", "The voice came back empty");
      const storageKey = "projects/" + projectId + "/assets/" + assetId + ".media";
      const stored = await dependencies.storage.putFile(path, storageKey);
      const asset: Asset = {
        id: assetId, projectId, kind: "audio", storageKey: stored.key, checksumSha256: stored.checksumSha256,
        ...(info ? { durationUs: info.durationUs } : {}),
        metadata: { filename: ("Voice-over · " + text.slice(0, 40) + (text.length > 40 ? "…" : "") + ".mp3").slice(0, 255), mimeType: "audio/mpeg", voiceover: true, voice, script: text.slice(0, 3000), hasAudio: true },
        createdAt: dependencies.clock(),
      };
      try { await dependencies.assets.save(asset); } catch (caught) { await dependencies.storage.remove(storageKey).catch(() => undefined); throw caught; }
      return reply.code(201).send({ asset });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
