# Release verification

A passing CI run is required but does not certify the running product. Keep a release blocked until the actual deployed build passes the user journey below.

## Deployment

The OCI host requires an authenticated operator session. No such session was available during this audit. Never place server credentials in source or browser configuration.

1. Wait for CI and all three container images for the exact main commit to succeed.
2. On the existing OCI installation, run `sudo bash ops/oci-staging/release.sh <commit-sha>` from a checkout of that release. The script requires successful CI for that exact commit, pins all three application images, leaves the database and other services running, checks readiness and API/web version identity, and restores the prior images/configuration on failure. It does not certify queue consumption or real media behavior.
3. Confirm the public `/api/version` and `/version.json` identify the same release. These routes expose a commit ID only. The loaded browser application also exposes its build ID as the root element’s `data-release` attribute, so a stale browser bundle can be identified.
4. Run the authenticated media journey and inspect API/render-worker logs. The deployment script has been syntax checked; execution and rollback on the actual host remain unverified until performed there.

## Required media journey

- Upload MP4/H.264 and a real phone MOV/HEVC; test portrait, landscape, silent video, rejected non-video input, oversize media, interruption and retry.
- Confirm transcript, word cuts, caption correction, cutaways, music, transitions, narration and undo/redo. Reload and confirm persistence. Verify concurrent stale edits are rejected.
- Ask the AI for a real plan and confirm the response identifies AI success rather than rules fallback. Confirm accepted stock assets match the preview.
- For Freedom: replace the old 0.2-second narration with the full requested closing narration after the video, review the repeated spoken words, render and inspect the result.
- Render 9:16, 16:9 and 1:1. Fully decode the outputs, inspect frames and speech/music/narration, and check length, sync, title/caption legibility and cutaway timing.
- Verify an export reconnects after a temporary request failure, survives reload, can be cancelled, and can be retried with a fresh attempt. A lost POST response must reuse its attempt key.
- Leave the editor open beyond URL lifetimes, and return after suspending it. Playback and download links must renew without losing the exported video's playback position.
- On real iPhone Safari and Android Chrome, test initial play, source speech, music, later narration, seeking and downloaded playback. A Chromium gesture test does not certify iOS.

## Operational gates

Run a backup restore rehearsal, queue/worker restart and storage-outage recovery; verify alert delivery and rollback. Docker log rotation stores bounded diagnostics, HTTP audit records store request outcomes, and export history stores render failures. These are not a demonstrated complete browser/process crash-history system.

No unconditional production-readiness claim has been made. Record release SHA, CI run, image publication, deployed version IDs, device/browser versions and evidence for each gate before changing that status.
