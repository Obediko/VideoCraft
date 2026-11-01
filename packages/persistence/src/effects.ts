import type { EffectLibraryRepository, SavedEffect } from "@videocraft/domain";
import { parseEffectRecipe } from "@videocraft/domain";
import type { Database } from "./index.js";
export class PostgresEffectLibraryRepository implements EffectLibraryRepository {
  constructor(private readonly db: Database) {}
  async list(userId: string): Promise<SavedEffect[]> {
    const { rows } = await this.db.query<{ id: string; recipe: unknown; updated_at: Date }>("SELECT id, recipe, updated_at FROM effect_library WHERE user_id=$1 ORDER BY updated_at DESC, id LIMIT 100", [userId]);
    return rows.map(r => ({ id: r.id, recipe: parseEffectRecipe(r.recipe), updatedAt: new Date(r.updated_at).toISOString() }));
  }
  async save(userId: string, effect: SavedEffect): Promise<void> {
    await this.db.query("INSERT INTO effect_library (user_id,id,recipe,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,id) DO UPDATE SET recipe=EXCLUDED.recipe, updated_at=EXCLUDED.updated_at", [userId, effect.id, JSON.stringify(parseEffectRecipe(effect.recipe)), effect.updatedAt]);
  }
  async remove(userId: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM effect_library WHERE user_id=$1 AND id=$2", [userId,id]);
  }
}
