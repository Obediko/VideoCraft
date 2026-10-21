# Operations

## Local services

The API requires PostgreSQL, Redis, DATABASE_URL, REDIS_URL, MEDIA_ROOT, AUTH_JWT_SECRET, DOWNLOAD_SIGNING_SECRET, and the faster-whisper worker path. Set DB_POOL_MAX, DB_CONNECTION_TIMEOUT_MS, DB_IDLE_TIMEOUT_MS, and REDIS_CONNECT_TIMEOUT_MS explicitly for production; the API validates these bounds and refuses invalid values. Run `npm run migrate --workspace=@videocraft/persistence` with DATABASE_URL during the controlled release step. The runner applies ordered SQL migrations transactionally and records completed versions in schema_migrations.

The API listens on 0.0.0.0 only inside its deployment network. Put TLS termination, request filtering, and a trusted identity provider in front of it. Local completed renders are served through five-minute HMAC-signed URLs; the signing secret must be at least 32 random characters.

The scene-detection worker is configured with SCENE_WORKER_PATH and runs as a bounded child process. Scene inputs are staged through the configured object-storage adapter, so S3 deployments do not expose object keys as filesystem paths.

The render worker requires DATABASE_URL and REDIS_URL plus the configured object-storage settings. Render outputs are stored under `projects/<project-id>/renders/` and download routes reject outputs outside that prefix. The FFmpeg planner renders review-approved caption tracks as bounded drawtext overlays; caption text is length-limited and passed as an argv filter, never through a shell. It stages referenced inputs into an isolated RENDER_WORK_ROOT (falling back to RENDER_ROOT), runs constrained FFmpeg work, and uploads the output through the same storage adapter used by the API. It persists lifecycle progress and output checksums, and can abort active FFmpeg work when a queued job is cancelled.

Asset records must use keys under `projects/<project-id>/assets/`; the application rejects cross-project keys before persistence.

## Storage providers

Set OBJECT_STORAGE_PROVIDER=local for development. Set OBJECT_STORAGE_PROVIDER=s3 for S3-compatible storage and provide S3_BUCKET, S3_REGION, and credentials through the runtime environment or secret manager. S3_ENDPOINT supports compatible providers such as MinIO; S3_FORCE_PATH_STYLE=true is useful for local emulators. In S3 mode, completed render download endpoints return provider-native presigned URLs and do not stream through the API.

## Upload scanning

Set CLAMAV_HOST and optionally CLAMAV_PORT to enable the ClamAV INSTREAM adapter. Set MALWARE_SCAN_REQUIRED=true in production; the API then refuses to start without CLAMAV_HOST. Files are scanned while still in the temporary upload location and are promoted to object storage only after a clean result. Scanner outages return a 503 and never promote the file.

## Health endpoints

- `GET /healthz` is a liveness check and does not require external dependencies.
- `GET /readyz` is a readiness check. The production API verifies PostgreSQL and Redis before reporting `{ "status": "ok" }`; dependency failures return HTTP 503 and identify the failed dependency without exposing connection details.
- Readiness checks must remain fast and bounded. They must not perform migrations or mutate application data.

## Retention and deletion

The `@videocraft/retention` package provides bounded cleanup over providers that support object listing. Cleanup requires an explicit cutoff, caps each run at 10,000 deletions, and accepts protected object keys; it never assumes that every old object is safe to remove. The retention worker reads protected asset and render-output keys from PostgreSQL, requires an explicit RETENTION_CUTOFF, and defaults to RETENTION_DRY_RUN=true. Set RETENTION_DRY_RUN=false only in a reviewed scheduled job; RETENTION_MAX_DELETES bounds each run and RETENTION_PREFIX scopes the object listing. Production scheduling must use a least-privilege storage identity and record a deletion audit before enabling destructive cleanup. Set RETENTION_INTERVAL_MS to 0 for one-shot execution (the default), or to a value between 60 seconds and 24 hours for the built-in non-overlapping scheduler; keep RETENTION_DRY_RUN=true until the schedule is reviewed.

## Observability

Intent-provider calls are bounded by `INTENT_PROVIDER_MAX_PER_MINUTE` per authenticated principal. Intent analysis is prompt-only by default; callers must explicitly set `includeTranscript=true` before persisted project speech is loaded into the provider request. API rate limits use Redis so the budget is shared across API instances; keep Redis available and monitor rejected requests.

The API exposes a Prometheus-compatible `/metrics` endpoint with bounded request counters and latency count/sum metrics labeled only by method, route template, and status. Set METRICS_AUTH_TOKEN to a random 32+ character secret in production; requests must use its Bearer token. Keep the endpoint inside the deployment network or behind platform access controls; it contains operational data and no request bodies or credentials.

## Production requirements

- Use a managed PostgreSQL instance with encrypted connections and automated backups.
- Store authentication, storage, scanner, and intent-provider secrets in a secret manager; never place them in repository files. The API consumes secrets through the `SecretProvider` boundary and currently ships an environment-backed adapter for platform-injected values. Set `INTENT_PROVIDER_MODE=rule-based` to keep intent analysis local, or set `INTENT_PROVIDER_MODE=external` with `INTENT_PROVIDER_URL` (HTTPS without embedded credentials), `INTENT_PROVIDER_MODEL`, and `INTENT_PROVIDER_API_KEY`; production startup rejects incomplete external-provider configuration. Set SECRET_PROVIDER=aws-secrets-manager and SECRET_MANAGER_SECRET_ID to load a JSON secret object from AWS Secrets Manager; the API merges it before validating production configuration and uses that merged environment for storage, scanner, worker, intent-provider, database, and signing configuration. The AWS SDK uses its standard credential chain.
- Configure AUTH_ISSUER and AUTH_AUDIENCE in production; the API refuses unsafe production startup without them, S3-backed storage, and required malware scanning. For signing-key rotation, deploy the new AUTH_JWT_SECRET with the old key in AUTH_JWT_SECRET_PREVIOUS, wait at least the maximum token lifetime, then remove the previous key. The API rejects a rotation where both values are identical.
- Run database migrations as a controlled release step.
- Run transcription and rendering as separate worker processes with least-privilege filesystem access.
- Configure OTEL_EXPORTER_OTLP_ENDPOINT for OTLP traces, keep connection pool limits/timeouts and health probes enabled, and load `ops/prometheus/videocraft-alerts.yml` into the Prometheus deployment. Route critical alerts to the on-call channel and review warning thresholds with real traffic.
- Restrict outbound provider access from workers and sandbox media processing.
- Configure retention, deletion, and malware signature update monitoring for source assets and derived artifacts. Run `@videocraft/backup-verifier-worker` against a known PostgreSQL custom-format backup; it verifies the manifest size and SHA-256, runs `pg_restore --list` without a shell, and records an audit event. Schedule it independently and alert on non-zero exit.
- Run the emulator-backed S3-compatible provider contract test in CI; add staging-bucket coverage before production cutover.

The current branch contains a deployable vertical slice, but the operational controls above remain explicit gates for broad public exposure.


## Cloud secret-manager rotation

For AWS Secrets Manager, use a staged JSON secret version rather than editing environment variables in place:

1. Generate a new random AUTH_JWT_SECRET of at least 32 characters and preserve the currently active key as AUTH_JWT_SECRET_PREVIOUS.
2. Publish the JSON as a new secret version and move the AWSCURRENT stage to that version. Keep the old value available only through AUTH_JWT_SECRET_PREVIOUS; do not expose either key in logs or CI output.
3. Restart or roll the API instances so each instance loads the same AWSCURRENT version. Verify /readyz, authentication with a token signed by the new key, and authentication with a still-valid token signed by the old key.
4. Wait for the configured identity-provider token maximum lifetime plus clock-skew allowance. During this overlap window, both keys must remain present.
5. Publish a follow-up version with AUTH_JWT_SECRET_PREVIOUS removed, move AWSCURRENT, and verify that an old token is rejected while a new token remains accepted.
6. Record the secret-version IDs, timestamps, verification results, and operator in the change record. Never record secret values.

If any verification fails, restore the prior secret version as AWSCURRENT; do not disable authentication or bypass the API startup checks.
