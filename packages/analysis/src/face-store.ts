import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFaceTrack, parseFaceTrack, type FaceTrackResult } from "./index.js";

/** The storage calls the face-track cache needs (a subset of @videocraft/storage's ObjectStorage). */
export interface FaceTrackStorage {
  resolve(key: string): string;
  putFile(sourcePath: string, key: string): Promise<unknown>;
  downloadToFile?(key: string, destinationPath: string): Promise<void>;
}
export interface FaceTrackSource { projectId: string; assetId: string; storageKey: string; }
export interface FaceTrackDetector { script: string; executable?: string; workRoot?: string; timeoutMs?: number; }

/** Where an asset's face track is kept: beside the asset, so deleting the project removes it too. */
export function faceTrackKey(projectId: string, assetId: string): string {
  return "projects/" + projectId + "/assets/" + assetId + ".faces.json";
}

/** The stored face track, or undefined when it has not been made yet. */
export async function readFaceTrack(storage: FaceTrackStorage, source: Pick<FaceTrackSource, "projectId" | "assetId">, workRoot?: string): Promise<FaceTrackResult | undefined> {
  const key = faceTrackKey(source.projectId, source.assetId);
  const directory = await mkdtemp(join(workRoot ?? tmpdir(), "videocraft-faces-"));
  try {
    let path = join(directory, "faces.json");
    if (storage.downloadToFile) await storage.downloadToFile(key, path); else path = storage.resolve(key);
    return parseFaceTrack(await readFile(path, "utf8"));
  } catch { return undefined; }
  finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}

/**
 * Reads the stored face track, or detects it (from `localPath` when the media is already on disk) and stores it,
 * so the API and the render worker share one copy per asset.
 */
export async function loadOrDetectFaceTrack(storage: FaceTrackStorage, source: FaceTrackSource, detector: FaceTrackDetector, localPath?: string): Promise<FaceTrackResult> {
  const stored = await readFaceTrack(storage, source, detector.workRoot);
  if (stored) return stored;
  const directory = await mkdtemp(join(detector.workRoot ?? tmpdir(), "videocraft-faces-"));
  try {
    let input = localPath;
    if (!input) {
      if (storage.downloadToFile) { input = join(directory, "input.media"); await storage.downloadToFile(source.storageKey, input); }
      else input = storage.resolve(source.storageKey);
    }
    const track = await detectFaceTrack(input, { script: detector.script, ...(detector.executable ? { executable: detector.executable } : {}), ...(detector.timeoutMs ? { timeoutMs: detector.timeoutMs } : {}) });
    const out = join(directory, "faces.json");
    await writeFile(out, JSON.stringify(track));
    await storage.putFile(out, faceTrackKey(source.projectId, source.assetId));
    return track;
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}
