# VideoCraft staging on the OCI host

Target: `130.61.84.214` (Ampere, arm64), Caddy in front of `hub` and `n8n`.
Site: `https://videocraft.emancipationdevelopment.org` (DNS A record already points here).

| Container | Image | Exposure |
|---|---|---|
| videocraft-web | ghcr.io/obediko/videocraft-web:staging | 127.0.0.1:18080 → Caddy `/` |
| videocraft-api | ghcr.io/obediko/videocraft-api:staging | 127.0.0.1:18081 → Caddy `/api/*` (prefix stripped) |
| videocraft-render-worker | ghcr.io/obediko/videocraft-render-worker:staging | none (pulls from Cloudflare Queues) |
| videocraft-postgres / redis / clamav / otel | upstream images | internal network only |

Run on the server, from a checkout of this repo:

```bash
sudo bash ops/oci-staging/deploy.sh   # prompts (hidden) for R2 keys, Queues token, GHCR read token
sudo bash ops/oci-staging/verify.sh   # end-to-end checks; prints no secrets
```

`deploy.sh` never stops or modifies existing containers. It appends one site block to the existing Caddyfile
after a backup, validates, and restores the backup if validation fails. Secrets are stored only in
`/opt/videocraft/.env` (root, mode 600). Internal secrets (DB password, JWT, signing, metrics) are generated there.

Auth for staging is HS256 JWT (`AUTH_ISSUER=https://videocraft.emancipationdevelopment.org`, `AUTH_AUDIENCE=videocraft-staging`);
there is no identity provider yet, so testers need a token minted from `AUTH_JWT_SECRET` on the server.
Traces go to a local OpenTelemetry collector (debug exporter) to satisfy production config validation.
