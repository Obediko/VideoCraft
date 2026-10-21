export interface SecretProvider {
  get(name: string): string | undefined;
}

export class EnvironmentSecretProvider implements SecretProvider {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>>) {}
  get(name: string): string | undefined {
    const value = this.environment[name];
    return value?.trim() || undefined;
  }
}


export interface SecretsManagerClientLike {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

export class AwsSecretsManagerProvider {
  private readonly client: SecretsManagerClientLike;
  constructor(private readonly secretId: string, region = process.env.AWS_REGION ?? "us-east-1", client?: SecretsManagerClientLike) {
    if (!secretId.trim()) throw new Error("AWS secret ID is required");
    this.client = client ?? (new SecretsManagerClient({ region }) as unknown as SecretsManagerClientLike);
  }

  async load(): Promise<Record<string, string>> {
    const response = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretId }));
    if (!response.SecretString) throw new Error("AWS secret does not contain SecretString");
    let parsed: unknown;
    try { parsed = JSON.parse(response.SecretString); } catch { throw new Error("AWS secret must contain a JSON object"); }
    if (!isSecretRecord(parsed)) throw new Error("AWS secret must contain only string values");
    return parsed;
  }
}

export async function loadSecretEnvironment(environment: Readonly<Record<string, string | undefined>>): Promise<Record<string, string | undefined>> {
  const provider = environment.SECRET_PROVIDER ?? "env";
  if (provider === "env") return { ...environment };
  if (provider !== "aws-secrets-manager") throw new Error("Unsupported SECRET_PROVIDER: " + provider);
  const values = await new AwsSecretsManagerProvider(environment.SECRET_MANAGER_SECRET_ID ?? "", environment.AWS_REGION).load();
  return { ...environment, ...values };
}

function isSecretRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

export function requireSecret(provider: SecretProvider, name: string, minimumLength = 1): string {
  const value = provider.get(name);
  if (!value) throw new Error(name + " is required");
  if (value.length < minimumLength) throw new Error(name + " must be at least " + minimumLength + " characters");
  return value;
}

import { createReadStream } from "node:fs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { connect } from "node:net";

export interface MalwareScanResult {
  clean: boolean;
  signature?: string;
}
export interface MalwareScanner {
  scan(path: string): Promise<MalwareScanResult>;
}
export interface ClamAvOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
}

export class ClamAvScanner implements MalwareScanner {
  private readonly options: Required<ClamAvOptions>;
  constructor(options: ClamAvOptions) {
    if (!options.host) throw new Error("ClamAV host is required");
    this.options = { host: options.host, port: options.port ?? 3310, timeoutMs: options.timeoutMs ?? 30_000 };
  }

  async scan(path: string): Promise<MalwareScanResult> {
    const input = createReadStream(path);
    return new Promise((resolvePromise, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port });
      let response = "";
      let settled = false;
      const finish = (error?: Error, result?: MalwareScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        input.destroy();
        error ? reject(error) : resolvePromise(result as MalwareScanResult);
      };
      const timer = setTimeout(() => finish(new Error("ClamAV scan timed out")), this.options.timeoutMs);
      const cleanup = () => clearTimeout(timer);
      socket.setTimeout(this.options.timeoutMs, () => finish(new Error("ClamAV socket timed out")));
      socket.on("connect", () => {
        socket.write(Buffer.from("zINSTREAM\0"));
        input.on("data", (chunk: string | Buffer) => {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          const size = Buffer.allocUnsafe(4); size.writeUInt32BE(buffer.length, 0);
          if (!socket.write(size) || !socket.write(buffer)) input.pause();
        });
        input.on("end", () => { socket.write(Buffer.alloc(4)); });
        input.on("error", (error) => finish(error));
      });
      socket.on("drain", () => input.resume());
      socket.on("data", (chunk) => { response += chunk.toString("utf8"); });
      socket.on("error", (error) => { cleanup(); finish(error); });
      socket.on("close", () => {
        cleanup();
        const parsed = parseClamAvResponse(response);
        if (parsed) finish(undefined, parsed);
        else finish(new Error("ClamAV returned an invalid response"));
      });
    });
  }
}

export function parseClamAvResponse(response: string): MalwareScanResult | undefined {
  const value = response.trim();
  if (value.endsWith("stream: OK")) return { clean: true };
  const match = value.match(/stream: (.+) FOUND$/);
  return match?.[1] ? { clean: false, signature: match[1] } : undefined;
}
