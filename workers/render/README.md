# Render worker

This worker consumes BullMQ jobs from videocraft-render, resolves only assets inside MEDIA_ROOT, and executes FFmpeg without a shell.

The initial renderer supports one video clip and at most one audio clip. Multi-clip concatenation, output object storage, manifests, and signed download URLs are intentionally separate follow-up slices. The worker must run in a constrained container with non-root permissions, CPU/memory/time limits, and no access to unrelated host paths.
