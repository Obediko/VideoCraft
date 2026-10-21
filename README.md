# VideoCraft

VideoCraft is an AI-assisted video editor designed to turn raw media and a creator's intent into explainable, reviewable editing suggestions and reproducible renders.

The current vertical slice includes authenticated projects and revisions, project-scoped multipart media ingestion, normalized faster-whisper transcripts, structured intent/audience analysis, versioned editing proposals, reviewable proposal decisions, durable BullMQ render jobs, FFmpeg rendering, signed playback URLs, and a browser editor surface.

This is not a claim that every production integration is complete: provider-backed object storage, database/Redis end-to-end tests, model-backed intent evaluation, OpenTimelineIO interchange, malware scanning, audit/observability, backup/retention, and keyboard/browser E2E hardening remain explicit roadmap work.

See [ARCHITECTURE.md](ARCHITECTURE.md), [docs/roadmap.md](docs/roadmap.md), and [docs/operations.md](docs/operations.md).
