# Roadmap

## Foundation - complete

- [x] Define domain vocabulary and invariants.
- [x] Define provider and infrastructure boundaries.
- [x] Document security and feedback-learning constraints.
- [x] Add domain-level validation tests.
- [x] Add application services for project creation, asset registration, and revision creation.
- [x] Add repository interfaces and in-memory adapters for deterministic tests.
- [x] Add a versioned strategy registry and explainable proposal strategy.

## Next vertical slice: persistent API flow

- [ ] Add database-backed repositories and migrations.
- [ ] Add authenticated API contracts for create project, add asset, and save revision.
- [ ] Add end-to-end tests for the persistent project flow.
- [ ] Add object-storage upload and signed download boundaries.

## Editing intelligence

- [ ] Add transcription ingestion with normalized segments.
- [ ] Add intent and audience extraction with structured outputs and evidence.
- [ ] Add proposal preview and explicit accept, reject, and edit commands.
- [ ] Add fixtures and offline strategy evaluation.

## Media pipeline

- [ ] Add idempotent render jobs and a worker queue.
- [ ] Add an FFmpeg adapter behind the renderer port.
- [ ] Add progress, cancellation, retry, and output manifests.
- [ ] Add scene-boundary analysis through an optional PySceneDetect adapter.
- [ ] Add OpenTimelineIO import/export after the internal timeline model stabilizes.

## Hardening

- [ ] Add authentication, authorization, tenant isolation, and audit logs.
- [ ] Add upload validation, malware scanning, rate limits, and secret management.
- [ ] Add observability, retention, backups, and incident runbooks.
- [ ] Add accessible browser timeline editing.
