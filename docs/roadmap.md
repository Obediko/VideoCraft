# Roadmap

## Foundation - current

- [x] Define domain vocabulary and invariants.
- [x] Define provider and infrastructure boundaries.
- [x] Document security and feedback-learning constraints.
- [x] Add domain-level test harness.

## Next vertical slice

- [ ] Add application services for project creation, asset registration, and revision creation.
- [ ] Add repository interfaces and a first persistence adapter.
- [ ] Add local development storage.
- [ ] Add API contracts and end-to-end tests for create project, add asset, save revision.

## Editing intelligence

- [ ] Add transcription ingestion with normalized segments.
- [ ] Add intent and audience extraction with structured outputs and evidence.
- [ ] Add a conservative short-form explainer strategy.
- [ ] Add proposal preview and explicit accept, reject, and edit commands.
- [ ] Add fixtures and offline strategy evaluation.

## Media pipeline

- [ ] Add idempotent render jobs and a worker queue.
- [ ] Add an FFmpeg adapter behind the renderer port.
- [ ] Add progress, cancellation, retry, and output manifests.

## Hardening

- [ ] Add authentication, authorization, tenant isolation, and audit logs.
- [ ] Add upload validation, malware scanning, rate limits, and secret management.
- [ ] Add observability, retention, backups, and incident runbooks.
- [ ] Add accessible browser timeline editing.
