import { createProxy } from "@videocraft/analysis";
import { processProxyTask, type MediaTask } from "@videocraft/jobs";
import { PostgresAssetRepository, type Database } from "@videocraft/persistence";
import { createStorage } from "./processor.js";

/** Runs background media tasks (browser preview proxies) for the API. */
export class MediaTaskProcessor {
  private readonly storage = createStorage();
  private readonly assets: PostgresAssetRepository;
  constructor(pool: Database) { this.assets = new PostgresAssetRepository(pool); }

  async process(task: MediaTask, attempt: { final: boolean }): Promise<"ready" | "skipped"> {
    return processProxyTask(task, {
      storage: this.storage,
      assets: this.assets,
      makeProxy: (input, output) => createProxy(input, output, process.env.FFMPEG_BIN ? { executable: process.env.FFMPEG_BIN } : {}),
      ...(process.env.RENDER_WORK_ROOT ? { workRoot: process.env.RENDER_WORK_ROOT } : {}),
    }, attempt);
  }
}
