# Open-source repository evaluation

Research date: 2026-10-21

This is a shortlist for VideoCraft, not a request to copy entire applications into the repository. Dependencies should be added only when a vertical slice needs them and after license, security, and operational review.

## Recommended candidates

| Repository | Role | Recommendation | Reason |
| --- | --- | --- | --- |
| FFmpeg/FFmpeg | Media probing and rendering worker | Use behind the rendering port | Mature, broad codec/filter/tooling surface. Keep it isolated in a constrained worker. License review is required because FFmpeg is primarily LGPL 2.1+ with optional GPL parts. |
| SYSTRAN/faster-whisper | Transcription adapter | Use for a self-hosted transcription option | Python/CTranslate2 implementation with word-level transcription support and strong CPU/GPU efficiency. Keep it behind TranscriptionPort; model and runtime terms must be reviewed separately. |
| AcademySoftwareFoundation/OpenTimelineIO | Timeline interchange | Use as an import/export boundary later | Mature editorial interchange model and adapters. Do not make OTIO the internal product model yet; VideoCraft needs tailoring evidence, proposals, feedback, and product-specific metadata. |
| Breakthrough/PySceneDetect | Scene and cut detection | Optional adapter | Useful for candidate shot boundaries and content-aware edits. It is not an editor or transcription system, so it fits as a focused analysis adapter. |
| taskforcesh/bullmq | Job queue | Good first queue candidate | Node/TypeScript-friendly Redis-backed queue with retries and operational tooling. Keep queue messages versioned and idempotent. |
| remotion-dev/remotion | Programmatic composition/rendering | Evaluate before adopting | Strong fit for React/TypeScript composition and reproducible rendering, but its current license is not a simple permissive OSS license for every commercial organization. Legal review is required before use. |

## Study, do not import initially

| Repository | Use |
| --- | --- |
| OpenCut-app/OpenCut | Study plugin-first editor boundaries and future headless/AI direction. The repository says it is being rewritten and points users to its archived classic version for current use, so it should not be a runtime dependency. |
| floomhq/opencut | Study transcript-driven, code-defined editing workflows. Validate activity, license, and maintenance before using ideas or code. |
| Temporalio/temporal | Reconsider if render/transcription workflows require durable multi-step orchestration, long pauses, or complex retries. It is operationally heavier than needed for the first vertical slice. |

## Decision for the first implementation slice

Start with:

1. FFmpeg through the RendererPort.
2. faster-whisper through the TranscriptionPort.
3. BullMQ for asynchronous render/transcription jobs.
4. PySceneDetect as an optional shot-boundary adapter.
5. OTIO import/export after the internal timeline model stabilizes.

Keep the internal domain model and provider ports owned by VideoCraft. Do not copy full editor applications or vendor-specific models into the repository.

## License and supply-chain notes

- FFmpeg must be built and distributed with an intentional LGPL/GPL configuration.
- Remotion requires entity-specific license review.
- Model weights, CUDA/CTranslate2 dependencies, and provider APIs may have terms independent of the wrapper repository.
- Pin versions, generate lockfiles, scan transitive dependencies, and record notices before production use.
- Treat downloaded media, model output, and third-party repository code as untrusted inputs until validated.
