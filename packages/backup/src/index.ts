import { createHash } from "node:crypto";
import { stat, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { ObjectStorage } from "@videocraft/storage";

export interface BackupArtifact {
  storageKey: string;
  expectedSha256: string;
  expectedSizeBytes: number;
}

export interface BackupVerifier {
  verify(path: string): Promise<void>;
}

export interface BackupVerificationResult {
  storageKey: string;
  sizeBytes: number;
  checksumSha256: string;
  verified: boolean;
}

export class PgRestoreListVerifier implements BackupVerifier {
  constructor(private readonly executable = "pg_restore", private readonly timeoutMs = 120_000) {}

  async verify(path: string): Promise<void> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run(this.executable, ["--list", path], { timeout: this.timeoutMs, maxBuffer: 2_000_000 });
  }
}

export async function verifyBackup(
  storage: ObjectStorage,
  verifier: BackupVerifier,
  artifact: BackupArtifact,
  destinationPath: string,
): Promise<BackupVerificationResult> {
  if (!storage.downloadToFile) throw new Error("Storage provider cannot download backup artifacts");
  if (!/^[a-f0-9]{64}$/i.test(artifact.expectedSha256)) throw new Error("Backup checksum must be a SHA-256 hex digest");
  if (!Number.isSafeInteger(artifact.expectedSizeBytes) || artifact.expectedSizeBytes < 1) throw new Error("Backup size must be a positive integer");

  try {
    await storage.downloadToFile(artifact.storageKey, destinationPath);
    const metadata = await stat(destinationPath);
    if (metadata.size !== artifact.expectedSizeBytes) throw new Error("Backup size does not match manifest");
    const hash = createHash("sha256");
    await pipeline((await import("node:fs")).createReadStream(destinationPath), hash);
    const actualSha256 = hash.digest("hex");
    if (actualSha256.toLowerCase() !== artifact.expectedSha256.toLowerCase()) throw new Error("Backup checksum does not match manifest");
    await verifier.verify(destinationPath);
    return { storageKey: artifact.storageKey, sizeBytes: metadata.size, checksumSha256: actualSha256, verified: true };
  } finally {
    await rm(destinationPath, { force: true }).catch(() => undefined);
  }
}
