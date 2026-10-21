import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage, StoredObject } from "./index.js";

export interface S3ObjectStorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  publicUrl?: string;
  client?: S3Client;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string | undefined;

  constructor(options: S3ObjectStorageOptions) {
    if (!options.bucket || !options.region) throw new Error("S3 bucket and region are required");
    this.bucket = options.bucket;
    this.publicUrl = options.publicUrl?.replace(/\/$/, "");
    this.client = options.client ?? new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
    });
  }

  resolve(_key: string): string {
    throw new Error("S3 objects are not local filesystem paths");
  }

  async putFile(sourcePath: string, key: string): Promise<StoredObject> {
    const metadata = await stat(sourcePath);
    const digest = createHash("sha256");
    const input = createReadStream(sourcePath);
    input.on("data", (chunk) => digest.update(chunk));
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: input }));
    return { key, path: this.publicUrl ? this.publicUrl + "/" + encodeObjectKey(key) : "s3://" + this.bucket + "/" + key, size: metadata.size, checksumSha256: digest.digest("hex") };
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async createDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) throw new Error("Invalid download URL lifetime");
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds });
  }
}

function encodeObjectKey(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
