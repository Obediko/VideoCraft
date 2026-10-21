# Operations

## Local services

The API requires PostgreSQL, DATABASE_URL, and AUTH_JWT_SECRET. Apply packages/persistence/migrations/001_initial.sql before starting the API.

The API listens on 0.0.0.0 only inside its deployment network. Put TLS termination, request filtering, and a trusted identity provider in front of it.

## Production requirements

- Use a managed PostgreSQL instance with encrypted connections and automated backups.
- Store AUTH_JWT_SECRET in a secret manager; never place it in repository files.
- Configure AUTH_ISSUER and AUTH_AUDIENCE when the identity provider supports them.
- Run database migrations as a controlled release step.
- Use a separate worker process for transcription and rendering.
- Add connection pool limits, timeouts, health probes, metrics, tracing, and structured audit events before public exposure.
- Restrict outbound provider access from workers and sandbox media processing.
- Configure retention and deletion jobs for source assets and derived artifacts.

The current API has an authenticated boundary and persistent repository implementation. It is not a complete production deployment until the operational controls above are wired to the target environment.
