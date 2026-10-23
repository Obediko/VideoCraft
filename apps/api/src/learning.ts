import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { describePreferences, learnPreferences, type EditingProposal, type LearnedPreferences, type PreferenceRepository, type PreferenceSample, type Timeline, type TimelineClip, type UUID } from "@videocraft/domain";

/** Clips with feature scores come from the highlight strategy; their fate teaches it. */
export const LEARNING_STRATEGY = "highlight-reel";
const HISTORY = 500;
const LABELS: Record<string, string> = { relevance: "relevance to the goal", hook: "opening hooks", density: "information density", completeness: "self-contained wording", length: "platform length", delivery: "delivery pace" };

const videoClips = (timeline: Timeline): TimelineClip[] => timeline.tracks.filter((track) => track.kind === "video").flatMap((track) => track.clips);

export function removedSamples(userId: UUID, projectId: UUID, revision: number, timeline: Timeline, removedIds: string[], now: string): PreferenceSample[] {
  return videoClips(timeline).filter((clip) => clip.features && removedIds.includes(clip.id)).map((clip) => ({
    key: "removed:" + projectId + ":" + revision + ":" + clip.id, userId, strategyId: LEARNING_STRATEGY, features: clip.features!, label: -1 as const, weight: 1, source: "removed" as const, createdAt: now,
  }));
}

export function exportedSamples(userId: UUID, projectId: UUID, revision: number, timeline: Timeline, now: string): PreferenceSample[] {
  // Keyed by source range rather than revision so re-exporting the same clips counts once.
  return videoClips(timeline).filter((clip) => clip.features).map((clip) => ({
    key: "exported:" + projectId + ":" + clip.assetId + ":" + clip.sourceStartUs + "-" + clip.sourceEndUs, userId, strategyId: LEARNING_STRATEGY, features: clip.features!, label: 1 as const, weight: 0.5, source: "exported" as const, createdAt: now,
  }));
}

export function rejectedSamples(userId: UUID, proposal: EditingProposal, now: string): PreferenceSample[] {
  return proposal.operations.flatMap((operation, index) => operation.type === "insert-clip" && operation.features ? [{
    key: "rejected:" + proposal.id + ":" + index, userId, strategyId: LEARNING_STRATEGY, features: operation.features, label: -1 as const, weight: 0.3, source: "rejected" as const, createdAt: now,
  }] : []);
}

export async function learnedFor(preferences: PreferenceRepository | undefined, userId: UUID): Promise<LearnedPreferences | undefined> {
  if (!preferences) return undefined;
  const learned = learnPreferences(await preferences.list(userId, LEARNING_STRATEGY, HISTORY));
  return Object.keys(learned.multipliers).length > 0 ? learned : undefined;
}

/** Learning must never break editing: failures are logged and ignored. */
export async function record(preferences: PreferenceRepository | undefined, samples: PreferenceSample[], log: (error: unknown) => void): Promise<void> {
  if (!preferences || samples.length === 0) return;
  try { await preferences.append(samples); } catch (error) { log(error); }
}

export function registerPreferenceRoutes(server: FastifyInstance, dependencies: { preferences: PreferenceRepository; authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null> }): void {
  server.get("/v1/me/preferences", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    const samples = await dependencies.preferences.list(principal.userId, LEARNING_STRATEGY, HISTORY);
    const learned = learnPreferences(samples);
    const counts = { removed: 0, exported: 0, rejected: 0 };
    for (const sample of samples) counts[sample.source] += 1;
    return { strategyId: LEARNING_STRATEGY, samples: samples.length, counts, multipliers: learned.multipliers, summary: describePreferences(learned, LABELS) ?? (samples.length < 3 ? "Not enough edits yet to learn from." : "No clear preference yet.") };
  });
  server.delete("/v1/me/preferences", async (request, reply) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return error(reply, 401, "unauthorized", "Authentication required");
    await dependencies.preferences.clear(principal.userId);
    return reply.code(204).send();
  });
}
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
