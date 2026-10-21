import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface StoredObject {
  key: string;
  path: string;
  size: number;
  checksumSha256: string;
}
export interface ObjectStorage {
  resolve(key: string): string;
  putFile(sourcePath: string, key: string): Promise<StoredObject>;
  remove(key: string): Promise<void>;
}

export class LocalObjectStorage implements ObjectStorage {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  resolve(key: string): string { return safeObjectPath(this.root, key); }

  async putFile(sourcePath: string, key: string): Promise<StoredObject> {
    const target = this.resolve(key);
    if (resolve(sourcePath) === target) throw new Error("Source and target must differ");
    await mkdir(dirname(target), { recursive: true });
    const temporary = target + ".uploading-" + process.pid + "-" + Date.now();
    const digest = createHash("sha256");
    const input = createReadStream(sourcePath);
    input.on("data", (chunk) => digest.update(chunk));
    await new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(temporary, { flags: "wx" });
      input.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolvePromise);
      input.pipe(output);
    });
    await rename(temporary, target);
    const metadata = await stat(target);
    return { key, path: target, size: metadata.size, checksumSha256: digest.digest("hex") };
  }

  async remove(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export function safeObjectPath(root: string, key: string): string {
  if (!key || isAbsolute(key) || key.includes("\0")) throw new Error("Invalid object key");
  const normalizedRoot = resolve(root);
  const candidate = resolve(normalizedRoot, key);
  const rel = relative(normalizedRoot, candidate);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("Object key escapes storage root");
  if (basename(candidate).startsWith(".") || candidate.endsWith(".uploading")) throw new Error("Reserved object key");
  return candidate;
}
