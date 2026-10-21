# Roadmap

## Foundation - complete

- [x] Define domain vocabulary and invariants.
- [x] Define provider and infrastructure boundaries.
- [x] Document security and feedback-learning constraints.
- [x] Add domain-level validation tests.
- [x] Add application services for project creation, validated project rename, asset registration, and revision creation.
- [x] Add repository interfaces and in-memory adapters for deterministic tests.
- [x] Add a versioned strategy registry and explainable proposal strategy.

## Persistent API flow - in progress

- [x] Add database-backed repositories and initial migrations.
- [x] Add a transactional migration runner with an applied-version ledger.
- [x] Add authenticated API contracts for project, asset, revision, transcript, render, proposal, and project-member commands.
- [x] Add CI integration tests against PostgreSQL and Redis.
- [x] Add a secure local object-storage boundary.
- [x] Add bounded multipart asset ingestion with project-scoped keys and checksums.
- [x] Add an S3-compatible object-storage adapter with provider-native signed download URLs.
- [x] Add provider-neutral object listing and a bounded protected-object cleanup primitive.
- [x] Add a PostgreSQL-protected retention worker with dry-run default and bounded deletion.
- [x] Add an emulator-backed S3-compatible provider contract test in CI.
- [x] Add a dry-run-first, bounded retention worker with protected-key audit records and opt-in non-overlapping scheduling.\n- [ ] Add production credential policy and external-provider integration tests.

## Editing intelligence - in progress

- [x] Add faster-whisper worker protocol and normalized transcript persistence.
- [x] Add non-destructive proposal preview with evidence and strategy version.
- [x] Add proposal persistence and accept/reject decisions as revision events.
- [x] Add durable feedback events for evaluation and future supervised improvement.
- [x] Add deterministic intent and audience extraction with structured outputs and evidence.
- [x] Add an explicit OpenAI-compatible structured-output intent provider adapter.
- [ ] Add provider credentials management and offline evaluation fixtures before enabling it by default.
- [x] Add fixtures and offline strategy evaluation metrics.

## Media pipeline - in progress

- [x] Add idempotent render jobs and a BullMQ queue.
- [x] Scope render idempotency keys to each project at both application and database layers.
- [x] Add an FFmpeg adapter and constrained render worker.
- [x] Stage render inputs and persist outputs through the configured local or S3-compatible storage adapter.
- [x] Add durable progress/status persistence, cancellation state, retries through BullMQ, and output manifests.
- [x] Add a typed PySceneDetect adapter and standalone scene worker.
- [x] Add a typed OTIO-shaped import/export adapter and authenticated API endpoints.
- [x] Add a Python OpenTimelineIO provider bridge with a fail-closed worker protocol and mocked round-trip tests.
- [x] Validate against the real OpenTimelineIO package in CI with a pinned worker dependency.

## Product surface - in progress

- [x] Add a web editor surface for projects, revisions, tailoring, proposal review, and render submission.
- [x] Add multipart uploads and render-status polling.
- [x] Add local HMAC-signed playback URLs and browser playback.
- [x] Add provider-native signed object-storage URLs.
- [x] Add keyboard-accessible timeline editing and a Playwright browser contract test.

## Hardening - in progress

- [x] Add fail-closed JWT authentication and project authorization hooks.
- [x] Add project-scoped authorization hooks and a global API rate limit.
- [x] Add append-only audit event persistence and request lifecycle coverage.
- [x] Add ClamAV upload scanning before storage promotion.
- [x] Add principal-keyed global rate limits and tighter intent/upload route budgets.
- [x] Add owner-controlled project member management with viewer/editor roles and non-owner denial tests.\n- [ ] Add complete tenant isolation audits and provider quota enforcement.
- [x] Add bounded request metrics and Prometheus-compatible export.
- [ ] Add distributed tracing, backup verification, and secret management.
