# Retention worker

This worker performs bounded object cleanup while protecting every asset key and render output key still referenced by PostgreSQL.

It is intentionally dry-run by default:

```text
RETENTION_CUTOFF=2026-01-01T00:00:00.000Z
RETENTION_DRY_RUN=true
RETENTION_MAX_DELETES=100
RETENTION_PREFIX=renders/
```

Run `npm run build --workspace=@videocraft/retention-worker`, then `npm start --workspace=@videocraft/retention-worker` from a controlled scheduler. Set `RETENTION_DRY_RUN=false` only after reviewing a dry-run result. Every completed run appends an audit event with the scope, mode, cutoff, and counts.

The worker supports local storage and the S3-compatible adapter through the same provider-neutral retention contract. Credentials must come from the runtime secret manager; no credentials belong in repository files.
