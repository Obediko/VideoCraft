# Cloudflare-first staging

VideoCraft uses Cloudflare as the edge and media platform while keeping the existing worker-friendly data and processing boundaries:

- Cloudflare R2 provides S3-compatible media and render storage.
- Cloudflare Queues provides durable render-job delivery.
- The existing PostgreSQL database remains the system of record.
- Redis remains the rate-limit and BullMQ compatibility store unless the queue provider is switched to Cloudflare.
- FFmpeg, faster-whisper, scene detection, and ClamAV run in a separate pull consumer with filesystem and network restrictions.

## R2

Create a private R2 bucket and configure:

```text
OBJECT_STORAGE_PROVIDER=s3
S3_BUCKET=<r2-bucket-name>
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_FORCE_PATH_STYLE=true
```

Use R2 credentials scoped only to the bucket. Do not expose the access key or secret in browser code.

## Queues

Create a queue named `videocraft-render`, enable its HTTP pull consumer, and create a scoped API token with Queues read/write permissions. Configure:

```text
JOB_QUEUE_PROVIDER=cloudflare
CF_ACCOUNT_ID=<cloudflare-account-id>
CF_QUEUE_ID=<queue-id>
CF_QUEUES_API_TOKEN=<scoped-token>
```

The API publishes render tasks over HTTPS. The external render worker pulls messages, stages project-scoped objects from R2, runs FFmpeg, persists progress and outputs through the API/database boundary, and acknowledges only after successful processing. On failure it retries the message; it never acknowledges a failed render.

Cloudflare Queues pull consumers are intentionally used instead of a Worker consumer because media processing is long-running and requires FFmpeg, Python, and ClamAV. Keep the queue token only on the API and worker runtimes.

## Free-tier expectation

This is suitable for a small staging environment, subject to Cloudflare's current quotas and billing. Media volume, queue operations, database, Redis, worker compute, and observability are separate cost centers. The repository does not create accounts, buckets, queues, or secrets automatically.
