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
- [x] Add authenticated API contracts for project, asset, revision, transcript, render, and proposal commands.
- [ ] Add end-to-end tests against PostgreSQL and Redis.
- [x] Add a secure local object-storage boundary.\n- [x] Add bounded multipart asset ingestion with project-scoped keys and checksums.
- [ ] Add production object storage and signed download URLs (local authenticated download remains the development adapter).

## Editing intelligence - in progress

- [x] Add faster-whisper worker protocol and normalized transcript persistence.
- [x] Add non-destructive proposal preview with evidence and strategy version.
- [x] Add proposal persistence and accept/reject decisions as revision events.
- [x] Add deterministic intent and audience extraction with structured outputs and evidence.\n- [ ] Add a model-backed intent provider after provider credentials and evaluation fixtures are available.
- [ ] Add fixtures and offline strategy evaluation.

## Media pipeline - in progress

- [x] Add idempotent render jobs and a BullMQ queue.
- [x] Add an FFmpeg adapter and constrained render worker.
- [x] Add durable progress/status persistence, cancellation state, retries through BullMQ, and output manifests.
- [x] Add a typed PySceneDetect adapter and standalone scene worker.
- [ ] Add OpenTimelineIO import/export after the internal timeline model stabilizes.

## Product surface - in progress

- [x] Add a web editor surface for projects, revisions, tailoring, proposal review, and render submission.
- [x] Add multipart uploads and render-status polling.\n- [ ] Add production signed object-storage URLs and browser playback.
- [ ] Add keyboard-accessible timeline editing and browser end-to-end tests.

## Hardening - in progress

- [x] Add fail-closed JWT authentication and project authorization hooks.
- [ ] Add complete tenant isolation, audit logs, malware scanning, and rate limits.
- [ ] Add observability, retention, backups, and secret management.
