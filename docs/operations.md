# Operations

## Local services

The API requires PostgreSQL, Redis, DATABASE_URL, REDIS_URL, MEDIA_ROOT, AUTH_JWT_SECRET, DOWNLOAD_SIGNING_SECRET, and the faster-whisper worker path. Apply packages/persistence/migrations/001_initial.sql before starting the API.

The API listens on 0.0.0.0 only inside its deployment network. Put TLS termination, request filtering, and a trusted identity provider in front of it. Local completed renders are served through five-minute HMAC-signed URLs; the signing secret must be at least 32 random characters.

The render worker requires DATABASE_URL and REDIS_URL plus the configured object-storage settings. It stages referenced inputs into an isolated RENDER_WORK_ROOT (falling back to RENDER_ROOT), runs constrained FFmpeg work, and uploads the output through the same storage adapter used by the API. It persists lifecycle progress and output checksums, and can abort active FFmpeg work when a queued job is cancelled.

## Storage providers

Set OBJECT_STORAGE_PROVIDER=local for development. Set OBJECT_STORAGE_PROVIDER=s3 for S3-compatible storage and provide S3_BUCKET, S3_REGION, and credentials through the runtime environment or secret manager. S3_ENDPOINT supports compatible providers such as MinIO; S3_FORCE_PATH_STYLE=true is useful for local emulators. In S3 mode, completed render download endpoints return provider-native presigned URLs and do not stream through the API.

## Upload scanning

Set CLAMAV_HOST and optionally CLAMAV_PORT to enable the ClamAV INSTREAM adapter. Set MALWARE_SCAN_REQUIRED=true in production; the API then refuses to start without CLAMAV_HOST. Files are scanned while still in the temporary upload location and are promoted to object storage only after a clean result. Scanner outages return a 503 and never promote the file.

## Health endpoints

- `GET /healthz` is a liveness check and does not require external dependencies.
- `GET /readyz` is a readiness check. The production API verifies PostgreSQL and Redis before reporting `{ "status": "ok" }`; dependency failures return HTTP 503 and identify the failed dependency without exposing connection details.
- Readiness checks must remain fast and bounded. They must not perform migrations or mutate application data.

## Retention and deletion

The `@videocraft/retention` package provides bounded cleanup over providers that support object listing. Cleanup requires an explicit cutoff, caps each run at 10,000 deletions, and accepts protected object keys; it never assumes that every old object is safe to remove. The retention worker reads protected asset and render-output keys from PostgreSQL, requires an explicit RETENTION_CUTOFF, and defaults to RETENTION_DRY_RUN=true. Set RETENTION_DRY_RUN=false only in a reviewed scheduled job; RETENTION_MAX_DELETES bounds each run and RETENTION_PREFIX scopes the object listing. Production scheduling must use a least-privilege storage identity and record a deletion audit before enabling destructive cleanup.

## Observability

The API exposes a Prometheus-compatible `/metrics` endpoint with bounded request counters and latency count/sum metrics labeled only by method, route template, and status. Keep the endpoint inside the deployment network or behind platform access controls; it contains operational data and no request bodies or credentials.

## Production requirements

- Use a managed PostgreSQL instance with encrypted connections and automated backups.
- Store authentication, storage, scanner, and intent-provider secrets in a secret manager; never place them in repository files.
- Configure AUTH_ISSUER and AUTH_AUDIENCE when the identity provider supports them.
- Run database migrations as a controlled release step.
- Run transcription and rendering as separate worker processes with least-privilege filesystem access.
- Add connection pool limits, timeouts, health probes, distributed tracing, and alerting before public exposure.
- Restrict outbound provider access from workers and sandbox media processing.
- Configure retention, deletion, backup verification, and malware signature update monitoring for source assets and derived artifacts.
- Add S3 integration tests against an emulator or staging bucket before production cutover.

The current branch contains a deployable vertical slice, but the operational controls above remain explicit gates for broad public exposure.
