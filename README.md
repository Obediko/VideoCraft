# VideoCraft

VideoCraft is an AI-assisted video editor designed to turn raw media and a creator's intent into explainable, reviewable editing suggestions and reproducible renders.

The current vertical slice includes authenticated projects and revisions, project-scoped multipart media ingestion, normalized faster-whisper transcripts, scene detection, structured intent/audience analysis, versioned editing proposals, reviewable proposal decisions, durable BullMQ render jobs, FFmpeg rendering, signed playback URLs, local and S3-compatible object-storage adapters, ClamAV upload scanning, audit events, bounded Prometheus metrics, liveness/readiness probes, OpenTimelineIO-shaped interchange, and a browser editor surface.

The implementation and automated CI cover the provider adapters, Redis quotas, backup/retention workers, distributed tracing and alert rules, pinned OpenTimelineIO bridge, browser contract, S3-emulator contract, and provider failure paths. Release still requires environment-specific verification with the operator’s real credentials, identity provider, storage, observability backend, worker images, and backup schedule; see docs/release-checklist.md. Feedback is stored for evaluation and product improvement; it is not represented as autonomous model training.

See [ARCHITECTURE.md](ARCHITECTURE.md), [docs/roadmap.md](docs/roadmap.md), and [docs/operations.md](docs/operations.md).
