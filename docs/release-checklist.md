# Release checklist

This checklist separates repository evidence from environment-specific release work. A green CI run proves the former; it does not prove that an operator has configured a production account.

## Automated evidence

- [x] TypeScript builds and typechecks across all workspaces.
- [x] Unit and package contract tests pass.
- [x] Browser editor contract tests pass.
- [x] Python timeline protocol tests pass.
- [x] PostgreSQL, Redis, and S3-emulator integration tests pass.
- [x] Authentication, project authorization, tenant isolation, upload scanning, quotas, and signed download tests pass.
- [x] Provider adapters fail closed on malformed responses, timeouts, invalid credentials, and invalid media ranges.
- [x] Render outputs and asset keys are project-scoped.
- [x] Backup verification, retention dry-run, audit events, metrics, traces, and alert rules are covered by code and tests.

## Environment verification before public exposure

- [ ] Provision managed PostgreSQL with TLS, backups, restore testing, and least-privilege credentials.
- [ ] Provision Redis with TLS/authentication, persistence policy, and capacity alerts.
- [ ] Provision S3-compatible storage with bucket policy, lifecycle policy, encryption, and a staging-bucket contract test.
- [ ] Configure the identity provider, issuer, audience, token lifetime, and JWT overlap rotation procedure.
- [ ] Configure ClamAV and verify signature updates and scanner outage behavior.
- [ ] Configure the transcription, scene-detection, render, and OpenTimelineIO worker images with pinned versions and restricted filesystem/network access.
- [ ] Configure the intent provider only after reviewing data-consent, retention, quota, and cost policies.
- [ ] Connect OTLP tracing and Prometheus alert delivery to the on-call system.
- [ ] Run a staging upload → transcription → scene detection → tailoring → proposal review → revision → render → signed download rehearsal.
- [ ] Run a restore rehearsal and retention dry-run; record audit evidence before enabling destructive deletion.
- [ ] Complete dependency, container, load, and penetration review for the selected deployment environment.

The repository intentionally does not perform deployment or mutate external infrastructure.
