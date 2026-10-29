import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Asset, UUID } from "@videocraft/domain";
import type { AssetRepository, RevisionRepository } from "@videocraft/application";
import type { ObjectStorage } from "@videocraft/storage";
import { MOODS, encodeWav, generateMusic, inferMood, type Mood } from "@videocraft/music";

export interface MusicRouteDependencies {
  assets: AssetRepository; revisions: RevisionRepository; storage: ObjectStorage;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, role: "viewer" | "editor"): Promise<boolean> };
  clock(): string;
}

/**
 * Composes an instrumental bed for a saved cut: exactly its length, lifting at its cut points, in a mood taken
 * from the brief (or chosen). Stored as an ordinary audio asset, so it is used like any uploaded music.
 */
export function registerMusicRoutes(server: FastifyInstance, dependencies: MusicRouteDependencies): void {
  server.post("/v1/projects/:projectId/music/generate", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } } as never, async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const { projectId } = request.params as { projectId?: string };
    if (!projectId || !(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return error(reply, 403, "forbidden", "Project access denied");
    const body = (request.body ?? {}) as { revision?: unknown; mood?: unknown; brief?: { intent?: unknown; audience?: unknown; tone?: unknown; channel?: unknown }; seed?: unknown };
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) return error(reply, 400, "invalid_request", "revision must be a positive integer");
    if (body.mood !== undefined && body.mood !== "auto" && !MOODS.includes(body.mood as Mood)) return error(reply, 400, "invalid_request", "mood must be auto or one of " + MOODS.join(", "));
    if (body.seed !== undefined && !(Number.isSafeInteger(body.seed) && (body.seed as number) >= 0)) return error(reply, 400, "invalid_request", "seed must be a non-negative integer");
    const revision = await dependencies.revisions.get(projectId, body.revision as number);
    if (!revision) return error(reply, 404, "not_found", "Revision not found");

    const clips = revision.timeline.tracks.filter((track) => track.kind === "video").flatMap((track) => track.clips).sort((a, b) => a.timelineStartUs - b.timelineStartUs);
    const lengthUs = clips.reduce((sum, clip) => sum + (clip.sourceEndUs - clip.sourceStartUs), 0);
    if (lengthUs < 3_000_000) return error(reply, 400, "invalid_request", "The cut must be at least 3 seconds long before music can be generated");
    if (lengthUs > 600_000_000) return error(reply, 400, "invalid_request", "Generated music is limited to 10 minutes");
    const text = (s: unknown) => (typeof s === "string" ? s.slice(0, 500) : "");
    const brief = body.brief ?? {};
    const tailoring = revision.tailoring;
    const mood: Mood = body.mood && body.mood !== "auto" ? (body.mood as Mood)
      : inferMood([text(brief.intent) || tailoring?.intent || "", text(brief.tone) || tailoring?.tone || "", text(brief.audience) || tailoring?.audience || ""].join(" "), text(brief.channel) || tailoring?.channel || "");
    const seed = typeof body.seed === "number" ? body.seed : createHash("sha256").update(projectId + ":" + revision.revision + ":" + mood).digest().readUInt32LE(0);
    const accentsS = clips.slice(1).map((clip) => clip.timelineStartUs / 1_000_000);

    const music = generateMusic({ mood, durationS: lengthUs / 1_000_000 + 1, accentsS, seed });
    const assetId = randomUUID();
    const directory = join(tmpdir(), "videocraft-music", assetId);
    const path = join(directory, "music.wav");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path, encodeWav(music.left, music.right, music.sampleRate));
      const stored = await dependencies.storage.putFile(path, "projects/" + projectId + "/assets/" + assetId + ".media");
      const asset: Asset = {
        id: assetId, projectId, kind: "audio", storageKey: stored.key, checksumSha256: stored.checksumSha256, durationUs: Math.round((music.left.length / music.sampleRate) * 1_000_000),
        metadata: { filename: "Generated " + mood + " " + music.bpm + " BPM.wav", mimeType: "audio/wav", generated: true, mood, bpm: music.bpm, key: music.key, chords: music.chords.join("-"), seed, hasAudio: true, hasVideo: false, container: "wav" },
        createdAt: dependencies.clock(),
      };
      await dependencies.assets.save(asset);
      return reply.code(201).send({ asset, music: { mood, bpm: music.bpm, key: music.key, description: music.description, seed } });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
