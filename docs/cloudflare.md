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
| Media processing | External restricted worker | Existing FFmpeg, Whisper, scene, and ClamAV workers |

The design keeps the data model and media worker contracts intact. Cloudflare-specific code is limited to the object-storage endpoint and queue producer; this preserves a future move to another S3-compatible provider or queue.

## Configuration

Set `OBJECT_STORAGE_PROVIDER=s3`, `S3_ENDPOINT` to the R2 endpoint, `S3_REGION=auto`, and `S3_FORCE_PATH_STYLE=true`. Set `JOB_QUEUE_PROVIDER=cloudflare` with `CF_ACCOUNT_ID`, `CF_QUEUE_ID`, and `CF_QUEUES_API_TOKEN`.

The API stores render-job state in PostgreSQL before acknowledging the HTTP request. The queue message contains the revision, render settings, and project-scoped asset keys needed by the worker. Database idempotency prevents duplicate publication for the same project and request key.

## Operational requirements

- Keep R2 buckets private and use signed URLs for playback.
- Scope R2 credentials to the staging bucket.
- Scope the Queues token to the account and queue permissions required by the API and pull worker.
- Use a pull consumer for FFmpeg and Python workloads; do not run media processing inside a request handler.
- Set the queue visibility timeout longer than the worker's maximum expected render duration.
- Acknowledge a message only after output checksum, database state, and object upload have succeeded.
- Keep the existing project-prefix checks for assets and renders.
- Validate R2 bucket lifecycle, encryption, restore, retention, and malware-scanning behavior in staging before public exposure.

This integration is implemented in the repository, but account creation, infrastructure provisioning, and deployment remain operator-controlled steps.
