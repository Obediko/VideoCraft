# Cloudflare integration

Cloudflare is the preferred edge and media layer for VideoCraft staging.

## Chosen boundaries

| Concern | Provider | Repository integration |
| --- | --- | --- |
| Browser edge and DNS | Cloudflare | External deployment configuration |
| Media and render objects | Cloudflare R2 | Existing S3-compatible object-storage adapter |
| Render delivery | Cloudflare Queues | `CloudflareQueueRenderQueue` |
| Transactional metadata | Managed PostgreSQL | Existing persistence package |
| Rate limits and compatibility | Redis | Existing Redis provider |
| Media processing | Restricted FFmpeg container | `workers/render` pull consumer |

The design keeps the data model and media worker contracts intact. Cloudflare-specific code is limited to the object-storage endpoint and queue producer/consumer protocol; this preserves a future move to another S3-compatible provider or queue.

## Configuration

Set `OBJECT_STORAGE_PROVIDER=s3`, `S3_ENDPOINT` to the R2 endpoint, `S3_REGION=auto`, and `S3_FORCE_PATH_STYLE=true`. Set `JOB_QUEUE_PROVIDER=cloudflare` with `CF_ACCOUNT_ID`, `CF_QUEUE_ID`, and `CF_QUEUES_API_TOKEN`.

The API stores render-job state in PostgreSQL before acknowledging the HTTP request. The queue message contains the revision, render settings, and project-scoped asset keys needed by the worker. Database idempotency prevents duplicate publication for the same project and request key.

## Render worker

The render worker pulls messages over HTTPS, processes one message at a time by default, and calls the Cloudflare acknowledgement endpoint only after FFmpeg succeeds, the output checksum is stored in R2, and PostgreSQL contains the completed job. Failed messages are explicitly retried with a bounded delay.

The `Staging render worker image` workflow publishes `ghcr.io/<owner>/videocraft-render-worker:staging`. A container host or managed container service must run that image with the staging environment variables. Cloudflare R2 and Queues provide storage and delivery; FFmpeg still requires a container runtime.

## Operational requirements

- Keep R2 buckets private and use signed URLs for playback.
- Scope R2 credentials to the staging bucket.
- Scope the Queues token to the account and queue permissions required by the API and pull worker.
- Set `CF_QUEUE_VISIBILITY_TIMEOUT_MS` longer than the worker's maximum expected render duration and no longer than Cloudflare's 12-hour limit.
- Acknowledge a message only after output checksum, database state, and object upload have succeeded.
- Keep the existing project-prefix checks for assets and renders.
- Run the container as an unprivileged user with CPU, memory, disk, and wall-clock limits.
- Validate R2 bucket lifecycle, encryption, restore, retention, and malware-scanning behavior in staging before public exposure.

This integration is implemented in the repository, but account creation, infrastructure provisioning, database access, and running the worker container remain operator-controlled steps.
