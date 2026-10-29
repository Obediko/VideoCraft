import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Removes scratch folders and files left behind by work that was interrupted (a crash or a redeploy mid-job):
 * entries in `directory` whose name starts with one of `prefixes` and that were last changed over `maxAgeMs` ago.
 * Returns how many were removed. Never throws.
 */
export async function sweepScratch(directory: string, prefixes: string[], maxAgeMs = 12 * 3600_000): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(directory)) {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const path = join(directory, name);
      try {
        if (Date.now() - (await stat(path)).mtimeMs < maxAgeMs) continue;
        await rm(path, { recursive: true, force: true }); removed += 1;
      } catch { /* in use or already gone */ }
    }
  } catch { /* no such folder yet */ }
  return removed;
}
