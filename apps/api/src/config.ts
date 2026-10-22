export interface ProductionEnvironment {
  NODE_ENV?: string;
  OBJECT_STORAGE_PROVIDER?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  AUTH_JWT_SECRET?: string;
  AUTH_JWT_SECRET_PREVIOUS?: string;
  MALWARE_SCAN_REQUIRED?: string;
  CLAMAV_HOST?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  METRICS_AUTH_TOKEN?: string;
  INTENT_PROVIDER_MODE?: string;
  INTENT_PROVIDER_API_KEY?: string;
  INTENT_PROVIDER_URL?: string;
  INTENT_PROVIDER_MODEL?: string;
  JOB_QUEUE_PROVIDER?: string;
  CF_ACCOUNT_ID?: string;
  CF_QUEUE_ID?: string;
  CF_QUEUES_API_TOKEN?: string;
}

export function validateProductionConfiguration(env: ProductionEnvironment): void {
  if (env.NODE_ENV !== "production") return;

  const missing: string[] = [];
  if (env.OBJECT_STORAGE_PROVIDER !== "s3") missing.push("OBJECT_STORAGE_PROVIDER=s3");
  if (!env.AUTH_ISSUER) missing.push("AUTH_ISSUER");
  if (!env.AUTH_AUDIENCE) missing.push("AUTH_AUDIENCE");
  if (env.AUTH_JWT_SECRET && env.AUTH_JWT_SECRET_PREVIOUS && env.AUTH_JWT_SECRET === env.AUTH_JWT_SECRET_PREVIOUS) {
    missing.push("AUTH_JWT_SECRET_PREVIOUS must differ from AUTH_JWT_SECRET");
  }
  if (env.MALWARE_SCAN_REQUIRED !== "true") missing.push("MALWARE_SCAN_REQUIRED=true");
  if (!env.CLAMAV_HOST) missing.push("CLAMAV_HOST");
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) missing.push("OTEL_EXPORTER_OTLP_ENDPOINT");
  if (!env.METRICS_AUTH_TOKEN || env.METRICS_AUTH_TOKEN.length < 32) missing.push("METRICS_AUTH_TOKEN (32+ characters)");

  const queueProvider = env.JOB_QUEUE_PROVIDER ?? "bullmq";
  if (queueProvider !== "bullmq" && queueProvider !== "cloudflare") missing.push("JOB_QUEUE_PROVIDER=bullmq|cloudflare");
  if (queueProvider === "cloudflare") {
    if (!env.CF_ACCOUNT_ID) missing.push("CF_ACCOUNT_ID");
    if (!env.CF_QUEUE_ID) missing.push("CF_QUEUE_ID");
    if (!env.CF_QUEUES_API_TOKEN || env.CF_QUEUES_API_TOKEN.length < 32) missing.push("CF_QUEUES_API_TOKEN (32+ characters)");
  }

  const providerMode = env.INTENT_PROVIDER_MODE ?? (env.INTENT_PROVIDER_API_KEY ? "external" : "rule-based");
  if (providerMode !== "rule-based" && providerMode !== "external") {
    missing.push("INTENT_PROVIDER_MODE=rule-based|external");
  }
  if (providerMode === "external") {
    if (!env.INTENT_PROVIDER_API_KEY) missing.push("INTENT_PROVIDER_API_KEY");
    if (!env.INTENT_PROVIDER_URL) {
      missing.push("INTENT_PROVIDER_URL");
    } else {
      try {
        const endpoint = new URL(env.INTENT_PROVIDER_URL);
        if (endpoint.protocol !== "https:") missing.push("INTENT_PROVIDER_URL=https://...");
        if (endpoint.username || endpoint.password) missing.push("INTENT_PROVIDER_URL without embedded credentials");
      } catch {
        missing.push("INTENT_PROVIDER_URL=https://...");
      }
    }
    if (!env.INTENT_PROVIDER_MODEL) missing.push("INTENT_PROVIDER_MODEL");
  }

  if (missing.length > 0) {
    throw new Error("Production configuration is not safe to start; missing or invalid: " + missing.join(", "));
  }
}
