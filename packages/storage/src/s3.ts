import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ListedObject, ObjectStorage, StoredObject } from "./index.js";

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
    await pipeline(createReadStream(sourcePath), digest);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(sourcePath) }));
    return { key, path: this.publicUrl ? this.publicUrl + "/" + encodeObjectKey(key) : "s3://" + this.bucket + "/" + key, size: metadata.size, checksumSha256: digest.digest("hex") };
  }

  async list(prefix = ""): Promise<ListedObject[]> {
    const objects: ListedObject[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        ...(prefix ? { Prefix: prefix } : {}),
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }));
      objects.push(...(result.Contents ?? []).flatMap((entry) => entry.Key && entry.LastModified
        ? [{ key: entry.Key, size: entry.Size ?? 0, lastModified: entry.LastModified.toISOString() }]
        : []));
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body || !("transformToWebStream" in response.Body)) throw new Error("S3 object did not return a stream");
    await pipeline(response.Body.transformToWebStream(), createWriteStream(destinationPath, { flags: "wx" }));
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async createDownloadUrl(key: string, expiresInSeconds: number, options: { filename?: string } = {}): Promise<string> {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) throw new Error("Invalid download URL lifetime");
    if (options.filename && !/^[a-zA-Z0-9._-]{1,128}$/.test(options.filename)) throw new Error("Invalid download filename");
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(options.filename ? { ResponseContentDisposition: 'attachment; filename="' + options.filename + '"' } : {}) }), { expiresIn: expiresInSeconds });
  }
}

function encodeObjectKey(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
