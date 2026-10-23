import type { Database } from "./index.js";
import type { PreferenceRepository, PreferenceSample, UUID } from "@videocraft/domain";

interface Row { key: string; user_id: string; strategy_id: string; features: Record<string, number>; label: number; weight: number; source: PreferenceSample["source"]; created_at: Date | string; }

export class PostgresPreferenceRepository implements PreferenceRepository {
  constructor(private readonly db: Database) {}
  async append(samples: PreferenceSample[]): Promise<void> {
    for (const sample of samples) {
      await this.db.query(
        "INSERT INTO preference_samples (key, user_id, strategy_id, features, label, weight, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (key) DO NOTHING",
        [sample.key, sample.userId, sample.strategyId, JSON.stringify(sample.features), sample.label, sample.weight, sample.source, sample.createdAt],
      );
    }
  }
  async list(userId: UUID, strategyId: string, limit: number): Promise<PreferenceSample[]> {
    const result = await this.db.query<Row>("SELECT key, user_id, strategy_id, features, label, weight, source, created_at FROM preference_samples WHERE user_id = $1 AND strategy_id = $2 ORDER BY created_at DESC LIMIT $3", [userId, strategyId, Math.max(1, Math.min(limit, 5_000))]);
    return result.rows.map((row) => ({ key: row.key, userId: row.user_id, strategyId: row.strategy_id, features: row.features, label: row.label === 1 ? 1 : -1, weight: Number(row.weight), source: row.source, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at }));
  }
  async clear(userId: UUID): Promise<void> {
    await this.db.query("DELETE FROM preference_samples WHERE user_id = $1", [userId]);
  }
}
