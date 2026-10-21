import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PgRestoreListVerifier, verifyBackup } from "@videocraft/backup";
import { PostgresAuditRepository, createPool, type Database } from "@videocraft/persistence";
import { LocalObjectStorage, S3ObjectStorage, type ObjectStorage } from "@videocraft/storage";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required");
  return value;
}
function createStorage(): ObjectStorage {
  if (process.env.OBJECT_STORAGE_PROVIDER === "s3") {
    return new S3ObjectStorage({
      bucket: required("S3_BUCKET"),
      region: process.env.S3_REGION ?? "us-east-1",
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      ...(process.env.S3_PUBLIC_URL ? { publicUrl: process.env.S3_PUBLIC_URL } : {}),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    });
  }
  return new LocalObjectStorage(required("MEDIA_ROOT"));
}
function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(name + " must be a positive integer");
  return value;
}

async function main(): Promise<void> {
  const pool = createPool(required("DATABASE_URL"));
  const workRoot = await mkdtemp(join(tmpdir(), "videocraft-backup-"));
  try {
    const audit = new PostgresAuditRepository(pool as unknown as Database);
    const result = await verifyBackup(
      createStorage(),
      new PgRestoreListVerifier(process.env.PG_RESTORE_BIN ?? "pg_restore"),
      {
        storageKey: required("BACKUP_STORAGE_KEY"),
        expectedSha256: required("BACKUP_EXPECTED_SHA256"),
        expectedSizeBytes: positiveInteger("BACKUP_EXPECTED_SIZE_BYTES"),
      },
      join(workRoot, "backup.dump"),
    );
    await audit.append({
      id: randomUUID(),
      action: "backup.verify",
      method: "WORKER",
      route: "backup",
      statusCode: 200,
      requestId: randomUUID(),
      metadata: { storageKey: result.storageKey, sizeBytes: result.sizeBytes, checksumSha256: result.checksumSha256, verified: result.verified },
      createdAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({ event: "backup.verified", ...result }));
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "backup.failed", error: error instanceof Error ? error.message : "unknown error" }));
  process.exitCode = 1;
});
