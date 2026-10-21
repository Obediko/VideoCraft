import { spawn } from "node:child_process";
import type { Timeline } from "@videocraft/domain";
import { exportOtio, importOtio, type OtioDocument } from "./index.js";

export interface PythonOtioRunner {
  (request: { operation: "export" | "import"; document?: OtioDocument }): Promise<unknown>;
}

export interface PythonOpenTimelineIOOptions {
  workerPath: string;
  pythonCommand?: string;
  runner?: PythonOtioRunner;
}

export class PythonOpenTimelineIOAdapter {
  private readonly run: PythonOtioRunner;

  constructor(options: PythonOpenTimelineIOOptions) {
    if (!options.workerPath) throw new Error("OpenTimelineIO worker path is required");
    this.run = options.runner ?? createProcessRunner(options.pythonCommand ?? "python", options.workerPath);
  }

  async export(timeline: Timeline, name = "VideoCraft timeline"): Promise<OtioDocument> {
    const response = await this.run({ operation: "export", document: exportOtio(timeline, name) });
    return readDocument(response);
  }

  async import(document: OtioDocument): Promise<Timeline> {
    const response = await this.run({ operation: "import", document });
    return importOtio(readDocument(response));
  }
}

function readDocument(value: unknown): OtioDocument {
  if (!isObject(value) || value.ok !== true || !isObject(value.document)) throw new Error(isObject(value) && typeof value.error === "string" ? value.error : "OpenTimelineIO worker returned an invalid response");
  return value.document as OtioDocument;
}

function createProcessRunner(pythonCommand: string, workerPath: string): PythonOtioRunner {
  return (request) => new Promise((resolvePromise, reject) => {
    const child = spawn(pythonCommand, [workerPath], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || "OpenTimelineIO worker failed"));
      try { resolvePromise(JSON.parse(stdout)); } catch { reject(new Error("OpenTimelineIO worker returned invalid JSON")); }
    });
    child.stdin.end(JSON.stringify(request) + "\n");
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
