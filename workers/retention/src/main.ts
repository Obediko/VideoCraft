import { PostgresAssetRepository, PostgresAuditRepository, PostgresRenderJobRepository, createPool, type Database } from "@videocraft/persistence";
import { randomUUID } from "node:crypto";
import { pruneExpiredObjects } from "@videocraft/retention";
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
      region: required("S3_REGION"),
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      ...(process.env.S3_PUBLIC_URL ? { publicUrl: process.env.S3_PUBLIC_URL } : {}),
      ...(process.env.S3_FORCE_PATH_STYLE === undefined ? {} : { forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" }),
    });
  }
  return new LocalObjectStorage(required("MEDIA_ROOT"));
}

async function main(): Promise<void> {
  const pool = createPool(required("DATABASE_URL"));
  try {
    const db = pool as unknown as Database;
    const assets = new PostgresAssetRepository(db);
    const renders = new PostgresRenderJobRepository(db);
    const audit = new PostgresAuditRepository(db);
    const protectedKeys = new Set([
      ...(await assets.listStorageKeys()),
      ...(await renders.listOutputStorageKeys()),
    ]);
    const maxDeletes = Number(process.env.RETENTION_MAX_DELETES ?? "100");
    const result = await pruneExpiredObjects(createStorage(), {
      ...(process.env.RETENTION_PREFIX ? { prefix: process.env.RETENTION_PREFIX } : {}),
      olderThan: required("RETENTION_CUTOFF"),
      protectedKeys,
      maxDeletes,
      dryRun: process.env.RETENTION_DRY_RUN !== "false",
    });
    await audit.append({
      id: randomUUID(),
      action: "retention.cleanup",
      method: "WORKER",
      route: "retention",
      statusCode: 200,
      requestId: randomUUID(),
      metadata: {
        cutoff: required("RETENTION_CUTOFF"),
        dryRun: process.env.RETENTION_DRY_RUN !== "false",
        examined: result.examined,
        eligible: result.eligible,
        deleted: result.deleted.length,
        planned: result.planned.length,
        skippedProtected: result.skippedProtected,
        remainingEligible: result.remainingEligible,
      },
      createdAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({ event: "retention.completed", ...result }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "retention.failed", error: error instanceof Error ? error.message : "unknown error" }));
  process.exitCode = 1;
});
