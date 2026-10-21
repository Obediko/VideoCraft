export interface ProductionEnvironment {
  NODE_ENV?: string;
  OBJECT_STORAGE_PROVIDER?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  MALWARE_SCAN_REQUIRED?: string;
  CLAMAV_HOST?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
}

export function validateProductionConfiguration(env: ProductionEnvironment): void {
  if (env.NODE_ENV !== "production") return;

  const missing: string[] = [];
  if (env.OBJECT_STORAGE_PROVIDER !== "s3") missing.push("OBJECT_STORAGE_PROVIDER=s3");
  if (!env.AUTH_ISSUER) missing.push("AUTH_ISSUER");
  if (!env.AUTH_AUDIENCE) missing.push("AUTH_AUDIENCE");
  if (env.MALWARE_SCAN_REQUIRED !== "true") missing.push("MALWARE_SCAN_REQUIRED=true");
  if (!env.CLAMAV_HOST) missing.push("CLAMAV_HOST");
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) missing.push("OTEL_EXPORTER_OTLP_ENDPOINT");

  if (missing.length > 0) {
    throw new Error("Production configuration is not safe to start; missing or invalid: " + missing.join(", "));
  }
}
