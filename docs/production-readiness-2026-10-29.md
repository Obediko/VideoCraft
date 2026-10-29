# VideoCraft production-readiness decision (2026-10-29)

**Decision: NO-GO for general public release.** Source inspection and commits are not substitutes for running the CI suite and verifying the deployed application. This document records observed evidence and gates, not a certification.

## Confirmed defects and repository changes

- Upload handler previously exposed raw EPIPE details and mislabeled server failures as HTTP 400. It now logs request IDs and returns suitable connection/server failures. This does not itself fix the underlying connection.
- Media inspection also exposed underlying process messages. It now records errors with request IDs and avoids disclosing internal exception text.
- When proxy queue submission failed without an inline proxy processor, fallback handling could attempt to invoke an absent function or leave status pending. The affected path is now guarded and marked failed.
- AI Director silently fell back to rules from the perspective of server operations. Routes now record fallback reasons and identifiers; **the model/provider failure still requires live logs to diagnose**.
- Render worker previously persisted a successful output without even probing its video stream. It now checks for the video stream, dimensions, non-empty output, and grossly truncated duration before publishing.
- Staging script now exercises video frame decoding and detects prolonged black regions in the synthetic, brightly colored export.
- An EPIPE regression test was added but has not been executed in this review.

## Release-blocking verification (each gate requires recorded evidence)

1. CI: build, typecheck, unit, integration, browser E2E, Python tests all pass on the exact release commit; capture run URL and SHA.
2. Real video uploads: test mobile MOV/HEVC, MP4/H.264, MKV, portrait/landscape, video without audio, interrupted upload, oversized media, and scanner outage. Verify asset and proxy statuses.
3. Editing: create projects, revise clips, apply/reject director proposals, captions, B-roll, voiceover, music, effects, reordering and undo/redo. Confirm autosave and refresh persistence.
4. AI Director: check actual model, API configuration, usage budget, provider 401/429/5xx/timeout behavior, safe fallback and diagnostics without leaking secrets. Confirm a valid AI-generated plan for a real transcript/video.
5. Exports: run music+effects+titles+captions+b-roll edits in 9:16, 16:9, and 1:1. Probe metadata, decode frames, assess sampled luminance, visual motion, sync, audio loudness, duration and device/browser playback. Avoid assuming all-black content is invalid when the edit intentionally contains black scenes.
6. Background jobs: verify transient retry, permanent failure, cancellation, worker restarts, queued jobs after restart, duplicate/idempotent submissions, R2 timeout, and database recovery.
7. Error history: define and implement durable, project-scoped failure events (stage, code, timestamp, request/job ID, attempts, deployment SHA). Retain redacted diagnostics centrally; ensure access control and retention/deletion.
8. Security: verify tenant isolation and authorization, token rotation, upload malware scanning, secrets, storage bucket policy, presigned URL expiration, rate limiting and dependency/container scanning.
9. Operations: run DB backup/restore rehearsal, R2 recovery, disk and memory stress test, telemetry/alerts, log retention and escalation; verify that the shared hub and n8n services remain unaffected.
10. Release/rollback: build images for exact commit, promote only after gates pass, deploy to staging, execute verify.sh and user-journey tests, capture evidence, verify rollback and only then consider public traffic.

## Findings that cannot currently be verified

- No shell or SSH session to the Oracle staging host was established.
- Public staging endpoints could not be fetched from the current environment.
- GitHub's connector did not return a relevant CI run for the queried commit; no passing suite or deployment is asserted.
- Historical server exceptions and the earlier AI model failure remain unconfirmed.
- The last reported blank screen may originate from a black render, missing video stream, or browser playback/codec behavior. The new validation narrows failure modes but does not prove a root cause.

## Immediate operator evidence to collect

From the deployment host, run the documented ops/oci-staging/verify.sh for the exact built commit; record passed/failed summary and investigate failures, and capture redacted API and render-worker logs tied to a specific failing project/job ID. Do not publish secrets or private uploaded media in logs.

**Exit criterion:** no known release blockers, passing required checks on the deployed release SHA, successful real-device playback and evidence of recoverable failures.