import test from "node:test";
import assert from "node:assert/strict";
import { validateProductionConfiguration } from "../dist/config.js";

const safe = {
  NODE_ENV: "production",
  OBJECT_STORAGE_PROVIDER: "s3",
  AUTH_ISSUER: "https://issuer.example",
  AUTH_AUDIENCE: "videocraft-api",
  MALWARE_SCAN_REQUIRED: "true",
  CLAMAV_HOST: "clamav",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318/v1/traces",
  METRICS_AUTH_TOKEN: "m".repeat(32),
  INTENT_PROVIDER_MODE: "rule-based"
};

test("production configuration requires durable storage, JWT claims, and malware scanning", () => {
  assert.doesNotThrow(() => validateProductionConfiguration(safe));
  assert.throws(
    () => validateProductionConfiguration({ ...safe, CLAMAV_HOST: undefined }),
    /CLAMAV_HOST/
  );
  assert.throws(
    () => validateProductionConfiguration({ ...safe, OBJECT_STORAGE_PROVIDER: "local" }),
    /OBJECT_STORAGE_PROVIDER=s3/
  );
  assert.throws(
    () => validateProductionConfiguration({ ...safe, AUTH_JWT_SECRET: "same", AUTH_JWT_SECRET_PREVIOUS: "same" }),
    /AUTH_JWT_SECRET_PREVIOUS must differ/
  );
});

test("production external intent providers require explicit secure credentials", () => {
  assert.doesNotThrow(() => validateProductionConfiguration({
    ...safe,
    INTENT_PROVIDER_MODE: "external",
    INTENT_PROVIDER_API_KEY: "provider-secret",
    INTENT_PROVIDER_URL: "https://provider.example/v1",
    INTENT_PROVIDER_MODEL: "intent-model"
  }));
  assert.throws(
    () => validateProductionConfiguration({ ...safe, INTENT_PROVIDER_MODE: "external" }),
    /INTENT_PROVIDER_API_KEY/
  );
  assert.throws(
    () => validateProductionConfiguration({
      ...safe,
      INTENT_PROVIDER_MODE: "external",
      INTENT_PROVIDER_API_KEY: "provider-secret",
      INTENT_PROVIDER_URL: "http://provider.example/v1",
      INTENT_PROVIDER_MODEL: "intent-model"
    }),
    /INTENT_PROVIDER_URL=https/
  );
  assert.throws(
    () => validateProductionConfiguration({ ...safe, INTENT_PROVIDER_MODE: "unexpected" }),
    /INTENT_PROVIDER_MODE/
  );
});

test("Cloudflare queue configuration requires scoped credentials", () => {
  assert.throws(
    () => validateProductionConfiguration({ ...safe, JOB_QUEUE_PROVIDER: "cloudflare" }),
    /CF_ACCOUNT_ID/
  );
  assert.doesNotThrow(() => validateProductionConfiguration({
    ...safe,
    JOB_QUEUE_PROVIDER: "cloudflare",
    CF_ACCOUNT_ID: "account",
    CF_QUEUE_ID: "queue",
    CF_QUEUES_API_TOKEN: "t".repeat(32)
  }));
});

test("non-production configuration remains usable for local development", () => {
  assert.doesNotThrow(() => validateProductionConfiguration({ NODE_ENV: "development" }));
});
