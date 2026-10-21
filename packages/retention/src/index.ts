import type { ObjectStorage } from "@videocraft/storage";

export interface RetentionOptions {
  prefix?: string;
  olderThan: string;
  protectedKeys?: ReadonlySet<string>;
  maxDeletes?: number;
}

export interface RetentionResult {
  examined: number;
  eligible: number;
  deleted: string[];
  skippedProtected: number;
  remainingEligible: number;
}

export async function pruneExpiredObjects(storage: ObjectStorage, options: RetentionOptions): Promise<RetentionResult> {
  if (!storage.list) throw new Error("Storage provider does not support object listing");
  const cutoff = Date.parse(options.olderThan);
  if (!Number.isFinite(cutoff)) throw new Error("Retention cutoff must be a valid ISO date");
  const maxDeletes = options.maxDeletes ?? 100;
  if (!Number.isSafeInteger(maxDeletes) || maxDeletes < 1 || maxDeletes > 10_000) throw new Error("Retention maxDeletes must be between 1 and 10,000");
  const protectedKeys = options.protectedKeys ?? new Set<string>();
  const objects = await storage.list(options.prefix ?? "");
  const eligible = objects.filter((object) => {
    const timestamp = Date.parse(object.lastModified);
    if (!Number.isFinite(timestamp)) throw new Error("Storage returned an invalid lastModified value");
    return timestamp < cutoff;
  });
  const deletable = eligible.filter((object) => !protectedKeys.has(object.key));
  const selected = deletable.slice(0, maxDeletes);
  for (const object of selected) await storage.remove(object.key);
  return {
    examined: objects.length,
    eligible: eligible.length,
    deleted: selected.map((object) => object.key),
    skippedProtected: eligible.length - deletable.length,
    remainingEligible: deletable.length - selected.length,
  };
}
