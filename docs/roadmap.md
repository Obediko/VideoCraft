# Roadmap

## Foundation - complete

- [x] Define domain vocabulary and invariants.
- [x] Define provider and infrastructure boundaries.
- [x] Document security and feedback-learning constraints.
- [x] Add domain-level validation tests.
- [x] Add application services for project creation, asset registration, and revision creation.
- [x] Add repository interfaces and in-memory adapters for deterministic tests.
- [x] Add a versioned strategy registry and explainable proposal strategy.

## Persistent API flow - in progress

- [x] Add database-backed repositories and initial migrations.
- [x] Add authenticated API contracts for project, asset, revision, transcript, and render commands.
- [ ] Add end-to-end tests against PostgreSQL and Redis.
- [x] Add a secure local object-storage boundary.
- [ ] Add production object storage and signed download URLs.

## Editing intelligence - in progress

- [x] Add faster-whisper worker protocol and normalized transcript persistence.
- [ ] Add intent and audience extraction with structured outputs and evidence.
- [ ] Add proposal preview and explicit accept, reject, and edit commands.
- [ ] Add fixtures and offline strategy evaluation.

## Media pipeline - in progress

- [x] Add idempotent render jobs and a BullMQ queue.
- [x] Add an FFmpeg adapter and constrained render worker.
- [ ] Add durable progress/status persistence, cancellation, retries, and output manifests.
- [ ] Add scene-boundary analysis through a PySceneDetect adapter.
- [ ] Add OpenTimelineIO import/export after the internal timeline model stabilizes.

## Hardening - in progress

- [x] Add fail-closed JWT authentication and project authorization hooks.
- [ ] Add complete tenant isolation, audit logs, malware scanning, and rate limits.
- [ ] Add observability, retention, backups, and secret management.
- [ ] Add accessible browser timeline editing.
