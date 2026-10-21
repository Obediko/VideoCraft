# Operations

## Local services

The API requires PostgreSQL, Redis, DATABASE_URL, REDIS_URL, MEDIA_ROOT, AUTH_JWT_SECRET, DOWNLOAD_SIGNING_SECRET, and the faster-whisper worker path. Apply packages/persistence/migrations/001_initial.sql before starting the API.

The API listens on 0.0.0.0 only inside its deployment network. Put TLS termination, request filtering, and a trusted identity provider in front of it. Completed renders are served through five-minute HMAC-signed URLs; the signing secret must be at least 32 random characters.

The render worker requires DATABASE_URL as well as REDIS_URL, MEDIA_ROOT, and RENDER_ROOT. It persists lifecycle progress and output checksums, and can abort active FFmpeg work when a queued job is cancelled.

## Production requirements

- Use a managed PostgreSQL instance with encrypted connections and automated backups.
- Store authentication and download-signing secrets in a secret manager; never place them in repository files.
- Configure AUTH_ISSUER and AUTH_AUDIENCE when the identity provider supports them.
- Run database migrations as a controlled release step.
- Run transcription and rendering as separate worker processes with least-privilege filesystem access.
- Add connection pool limits, timeouts, health probes, metrics, tracing, and structured audit events before public exposure.
- Replace the local object-storage adapter with a provider adapter that issues provider-native signed URLs.
- Restrict outbound provider access from workers and sandbox media processing.
- Configure retention, deletion, malware scanning, and backup verification for source assets and derived artifacts.

The current branch contains a deployable vertical slice, but the operational controls above remain explicit gates for broad public exposure.
