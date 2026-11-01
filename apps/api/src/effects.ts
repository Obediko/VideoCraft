import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { EFFECT_PRESETS, parseEffectRecipe, type EffectLibraryRepository, type EffectRecipe, type SavedEffect } from "@videocraft/domain";
export function savedEffect(recipe: EffectRecipe): SavedEffect {
  const clean = parseEffectRecipe(recipe);
  return { id: createHash("sha256").update(JSON.stringify(clean)).digest("hex"), recipe: clean, updatedAt: new Date().toISOString() };
}
export function registerEffectRoutes(server: FastifyInstance, deps: { effects: EffectLibraryRepository; authenticate(request: FastifyRequest): Promise<{ userId: string } | null> }): void {
  server.get("/v1/me/effects", async (request, reply) => {
    const user = await deps.authenticate(request);
    if (!user) return reply.code(401).send({ error: { message: "Sign in to open your effects library" } });
    return { presets: EFFECT_PRESETS, saved: await deps.effects.list(user.userId) };
  });
  server.post("/v1/me/effects", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const user = await deps.authenticate(request);
    if (!user) return reply.code(401).send({ error: { message: "Sign in to save effects" } });
    let effect: SavedEffect;
    try { effect = savedEffect(parseEffectRecipe(request.body)); }
    catch (error) { return reply.code(400).send({ error: { message: (error as Error).message } }); }
    await deps.effects.save(user.userId, effect);
    return reply.code(201).send({ effect });
  });
  server.delete<{ Params: { id: string } }>("/v1/me/effects/:id", async (request, reply) => {
    const user = await deps.authenticate(request);
    if (!user) return reply.code(401).send({ error: { message: "Sign in to remove effects" } });
    if (!/^[a-f0-9]{64}$/.test(request.params.id)) return reply.code(400).send({ error: { message: "Invalid effect id" } });
    await deps.effects.remove(user.userId, request.params.id);
    return reply.code(204).send();
  });
}
