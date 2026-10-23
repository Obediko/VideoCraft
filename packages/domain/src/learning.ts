import type { UUID } from "./index.js";

/**
 * One labelled observation of a strategy-chosen clip: its feature scores (each 0..1) and whether the
 * person kept it (+1) or threw it away (-1). `key` makes recording idempotent.
 */
export interface PreferenceSample {
  key: string;
  userId: UUID;
  strategyId: string;
  features: Record<string, number>;
  label: 1 | -1;
  /** How strong the signal is: removing a clip is 1, keeping it through an export 0.5, rejecting a whole proposal 0.3. */
  weight: number;
  source: "removed" | "exported" | "rejected";
  createdAt: string;
}

export interface PreferenceRepository {
  /** Stores samples, ignoring any whose key is already stored. */
  append(samples: PreferenceSample[]): Promise<void>;
  /** Most recent first. */
  list(userId: UUID, strategyId: string, limit: number): Promise<PreferenceSample[]>;
  clear(userId: UUID): Promise<void>;
}

export interface LearnedPreferences {
  /** Multiplier per feature applied to the strategy's base weights (1 = unchanged). */
  multipliers: Record<string, number>;
  samples: number;
}

export interface LearningOptions { rate?: number; min?: number; max?: number; minSamples?: number; }

/**
 * Multiplicative-weights update: features that were high on kept clips gain weight, features high on
 * removed clips lose it. Features are centred per sample so only the clip's profile matters, not its
 * overall score. Multipliers are clamped so learning can tilt, never take over, the base policy.
 */
export function learnPreferences(samples: PreferenceSample[], options: LearningOptions = {}): LearnedPreferences {
  const rate = options.rate ?? 0.6;
  const min = options.min ?? 0.5;
  const max = options.max ?? 2;
  const minSamples = options.minSamples ?? 3;
  if (samples.length < minSamples) return { multipliers: {}, samples: samples.length };
  const logs: Record<string, number> = {};
  const chronological = [...samples].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const sample of chronological) {
    const entries = Object.entries(sample.features).filter(([, value]) => Number.isFinite(value));
    if (entries.length === 0) continue;
    const mean = entries.reduce((sum, [, value]) => sum + value, 0) / entries.length;
    for (const [feature, value] of entries) {
      const next = (logs[feature] ?? 0) + rate * sample.label * sample.weight * (value - mean);
      logs[feature] = Math.min(Math.log(max), Math.max(Math.log(min), next));
    }
  }
  const multipliers: Record<string, number> = {};
  for (const [feature, log] of Object.entries(logs)) multipliers[feature] = Math.round(Math.exp(log) * 1000) / 1000;
  return { multipliers, samples: samples.length };
}

/** "favouring X and Y; de-emphasising Z" for the multipliers that moved noticeably. */
export function describePreferences(learned: LearnedPreferences, labels: Record<string, string> = {}): string | undefined {
  const moved = Object.entries(learned.multipliers).filter(([, m]) => Math.abs(m - 1) >= 0.08);
  if (moved.length === 0) return undefined;
  const name = (feature: string) => labels[feature] ?? feature;
  const up = moved.filter(([, m]) => m > 1).sort((a, b) => b[1] - a[1]).map(([f]) => name(f));
  const down = moved.filter(([, m]) => m < 1).sort((a, b) => a[1] - b[1]).map(([f]) => name(f));
  return [up.length ? "favouring " + up.join(" and ") : "", down.length ? "de-emphasising " + down.join(" and ") : ""].filter(Boolean).join("; ");
}

/** Validates a feature map from untrusted input: at most 16 finite numbers in [0, 1]. */
export function sanitizeFeatures(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(([key, v]) => /^[a-z][a-zA-Z]{0,30}$/.test(key) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1);
  return entries.length > 0 && entries.length <= 16 ? Object.fromEntries(entries) as Record<string, number> : undefined;
}
