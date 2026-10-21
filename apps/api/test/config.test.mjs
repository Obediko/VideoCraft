import test from "node:test";
import assert from "node:assert/strict";
import { validateProductionConfiguration } from "../dist/config.js";

const safe = {
  NODE_ENV: "production",
  OBJECT_STORAGE_PROVIDER: "s3",
  AUTH_ISSUER: "https://issuer.example",
  AUTH_AUDIENCE: "videocraft-api",
  MALWARE_SCAN_REQUIRED: "true",
  CLAMAV_HOST: "clamav"
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

test("non-production configuration remains usable for local development", () => {
  assert.doesNotThrow(() => validateProductionConfiguration({ NODE_ENV: "development" }));
});
