# Container deployment

VideoCraft publishes three staging images to GitHub Container Registry:

- `ghcr.io/<owner>/videocraft-web:staging` — browser application on port 8080
- `ghcr.io/<owner>/videocraft-api:staging` — Fastify API on port 8080
- `ghcr.io/<owner>/videocraft-render-worker:staging` — FFmpeg Cloudflare Queues consumer

All three images target `linux/amd64` and `linux/arm64`.

The web container is an SPA server. The host reverse proxy should route the public web hostname to the web container and route `/api` or the configured API hostname to the API container. Keep the API, PostgreSQL, render worker, R2, and Queues network private; only the web entry point should be public.

The API and render worker require runtime environment variables. Do not bake secrets into images or pass them through browser configuration. The render worker requires a long-lived container runtime with network access to PostgreSQL, R2, and Cloudflare Queues.

The workflow publishes images but does not log in to or mutate a server. Host deployment remains an operator-controlled step so existing services such as hub and n8n are not changed accidentally.

## Minimum host checks

Before starting containers, confirm:

- the host has Docker or another OCI-compatible runtime;
- PostgreSQL is reachable from the API and render worker;
- the staging R2 bucket and Cloudflare Queue are reachable;
- GHCR credentials are read-only and scoped to the required packages;
- host ports and reverse-proxy routes do not collide with existing services;
- persistent volumes exist for database data and any required local work space;
- CPU, memory, temporary disk, and render timeout limits are set for the worker.
