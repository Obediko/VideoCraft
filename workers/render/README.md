# Render worker

This worker supports two queue modes:

- \`JOB_QUEUE_PROVIDER=bullmq\` uses Redis/BullMQ for local development and compatibility.
- \`JOB_QUEUE_PROVIDER=cloudflare\` pulls from Cloudflare Queues over HTTPS and acknowledges messages only after the output is uploaded and the render job is persisted.

The worker stages only the asset keys present in the queue task, runs FFmpeg without a shell, writes results beneath the project render prefix, and removes temporary files after each task. A cancelled or already-succeeded job is not rendered again.

## Staging container

Build from the repository root:

\`\`\`text
docker build -f workers/render/Dockerfile -t videocraft-render-worker .
\`\`\`

The image includes FFmpeg and runs as the unprivileged \`node\` user. It requires a network path to PostgreSQL, Cloudflare R2, and Cloudflare Queues.

Required runtime variables:

\`\`\`text
JOB_QUEUE_PROVIDER=cloudflare
DATABASE_URL=postgres://...
OBJECT_STORAGE_PROVIDER=s3
S3_BUCKET=videocraft-staging
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
CF_ACCOUNT_ID=...
CF_QUEUE_ID=...
CF_QUEUES_API_TOKEN=...
\`\`\`

Optional queue controls:

- \`CF_QUEUE_BATCH_SIZE\` (default \`1\`)
- \`CF_QUEUE_VISIBILITY_TIMEOUT_MS\` (default \`3600000\`, maximum \`43200000\`)
- \`CF_QUEUE_POLL_INTERVAL_MS\` (default \`2000\`)
- \`RENDER_CONCURRENCY\` remains available for BullMQ mode; Cloudflare pull mode processes one message at a time per container.

The GitHub workflow publishes \`ghcr.io/<owner>/videocraft-render-worker:staging\`. Publishing the image is not the same as running it: a long-lived container host or managed container service must run this image with the staging environment variables. Cloudflare R2 and Queues provide storage and delivery; FFmpeg still requires a container runtime.

## Safety boundaries

Keep the container non-root, restrict filesystem and network permissions, set CPU/memory/time limits at the host, and never expose queue or R2 credentials to browser code.
