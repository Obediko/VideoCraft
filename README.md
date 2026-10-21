# VideoCraft

VideoCraft is an AI-assisted video editor designed to turn raw media and a creator's intent into explainable, reviewable editing suggestions and reproducible renders.

The current vertical slice includes authenticated projects and revisions, project-scoped multipart media ingestion, normalized faster-whisper transcripts, scene detection, structured intent/audience analysis, versioned editing proposals, reviewable proposal decisions, durable BullMQ render jobs, FFmpeg rendering, signed playback URLs, local and S3-compatible object-storage adapters, ClamAV upload scanning, audit events, bounded Prometheus metrics, liveness/readiness probes, OpenTimelineIO-shaped interchange, and a browser editor surface.

The system deliberately separates implemented behavior from production gates that still need environment-specific validation: real provider credentials and quotas, backup/retention operations, distributed tracing and alerting, an installed OpenTimelineIO worker image, and broader browser, storage-emulator, and provider-contract coverage. Feedback is stored for evaluation and product improvement; it is not represented as autonomous model training.

See [ARCHITECTURE.md](ARCHITECTURE.md), [docs/roadmap.md](docs/roadmap.md), and [docs/operations.md](docs/operations.md).
