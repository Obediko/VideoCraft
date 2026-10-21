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

test("non-production configuration remains usable for local development", () => {
  assert.doesNotThrow(() => validateProductionConfiguration({ NODE_ENV: "development" }));
});
