# VideoCraft

VideoCraft is an AI-assisted video editor designed to turn raw media and a creator's intent into explainable, reviewable editing suggestions and reproducible renders.

The current vertical slice includes authenticated projects and revisions, project-scoped multipart media ingestion, normalized faster-whisper transcripts, scene detection, structured intent/audience analysis, versioned editing proposals, reviewable proposal decisions, durable BullMQ render jobs, FFmpeg rendering, signed playback URLs, local and S3-compatible object-storage adapters, ClamAV upload scanning, audit events, bounded Prometheus metrics, liveness/readiness probes, OpenTimelineIO-shaped interchange, and a browser editor surface.

The implementation and automated CI cover the provider adapters, Redis quotas, backup/retention workers, distributed tracing and alert rules, pinned OpenTimelineIO bridge, browser contract, S3-emulator contract, and provider failure paths. Release still requires environment-specific verification with the operator’s real credentials, identity provider, storage, observability backend, worker images, and backup schedule; see docs/release-checklist.md. Feedback is stored for evaluation and product improvement; it is not represented as autonomous model training.

**Editing pipeline.** Uploads are validated with ffprobe; transcripts carry word timestamps; the `highlight-reel` strategy scores candidate windows against the goal, audience and platform (relevance, hook, density, completeness, length, delivery), cuts pauses, and explains each pick with timestamped transcript evidence. The timeline is editable (insert, trim, reorder, remove) with source-bound captions that follow cuts and can be corrected, and renders are produced by FFmpeg with burned-in captions in platform presets (9:16, 16:9, 1:1). `test/e2e/` exercises this on a real video; its README lists what is and is not verified. Scoring is heuristic (no LLM), and reframing is a centre crop.

See [ARCHITECTURE.md](ARCHITECTURE.md), [docs/roadmap.md](docs/roadmap.md), and [docs/operations.md](docs/operations.md).
