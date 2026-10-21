import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectStorage } from "@videocraft/storage";

export interface Scene {
  id: string;
  startUs: number;
  endUs: number;
}
export interface SceneDetector {
  detect(storageKey: string): Promise<Scene[]>;
}
export interface PySceneDetectOptions {
  workerPath: string;
  pythonCommand?: string;
  storage: ObjectStorage;
  timeoutMs?: number;
}

export class PySceneDetectWorker implements SceneDetector {
  private readonly options: Required<PySceneDetectOptions>;
  constructor(options: PySceneDetectOptions) {
    this.options = {
      ...options,
      pythonCommand: options.pythonCommand ?? "python",
      timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
    };
  }

  async detect(storageKey: string): Promise<Scene[]> {
    const temporaryDirectory = this.options.storage.downloadToFile ? await mkdtemp(join(tmpdir(), "videocraft-scene-")) : undefined;
    const inputPath = temporaryDirectory ? join(temporaryDirectory, "input.media") : this.options.storage.resolve(storageKey);
    try {
      if (temporaryDirectory) await this.options.storage.downloadToFile!(storageKey, inputPath);
      const child = spawn(this.options.pythonCommand, [this.options.workerPath], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
      const timer = setTimeout(() => child.kill("SIGTERM"), this.options.timeoutMs);
      try {
        child.stdin.end(JSON.stringify({ inputPath }) + "\n");
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (code !== 0) throw new Error("Scene detection worker failed: " + Buffer.concat(errors).toString().slice(-4000));
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(output).toString()); } catch { throw new Error("Scene detection worker returned invalid JSON"); }
        if (!isObject(value) || !Array.isArray(value.scenes)) throw new Error("Invalid scene detection response");
        return value.scenes.map((scene, index) => {
          if (!isObject(scene) || typeof scene.startUs !== "number" || typeof scene.endUs !== "number" || scene.endUs <= scene.startUs) throw new Error("Invalid scene at index " + index);
          return { id: typeof scene.id === "string" ? scene.id : "scene-" + index, startUs: scene.startUs, endUs: scene.endUs };
        });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
