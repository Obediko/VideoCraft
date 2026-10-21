# @videocraft/rendering

Planned rendering boundary. The renderer will accept an immutable project revision and explicit settings, produce an idempotent job, and emit an output manifest with checksums and metadata. FFmpeg or another media runtime belongs behind the renderer port in a constrained worker.
