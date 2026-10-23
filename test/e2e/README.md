# Real-media pipeline test

`pipeline.e2e.test.mjs` runs the real API stack (real HTTP server, real ffprobe / ffmpeg adapters, real
FFmpeg renderer) against a real video file and checks the outputs, not just the responses.

Flow: upload (junk and audio-only files rejected) → transcript with word timestamps → silence detection →
`highlight-reel` proposal (relevance to the stated goal, timestamped transcript evidence) → accept → edit
(insert/trim, reorder, caption correction) → render TikTok 9:16, YouTube 16:9 and no-caption variants.
Renders are checked with ffprobe (dimensions, duration), a full decode, an SSIM check of the caption band, and
a re-transcription of the exported audio (must contain the on-topic content and none of the cut content).

## Browser UI test

`ui.e2e.test.mjs` drives the real web editor in Chromium against the same real stack: sign up, upload, transcribe,
find highlights (reasons, scores and timestamped evidence are asserted), accept, trim, correct a caption, check the
signed source-playback URL and byte-range seeking, then export 9:16 and verify the downloaded file with ffprobe and
a full decode. It found two real bugs when first run (body-less POSTs rejected by the API; upload handler crash).
Playwright's open-source Chromium cannot decode H.264, so in-browser *playback* is asserted only where the browser
supports it (the test says so when it skips that step). Set `PLAYWRIGHT_CHROMIUM` to use another browser binary.

## Running it

The test is skipped unless offline speech models are available, because the production transcriber
(faster-whisper) downloads weights from Hugging Face.

```
pip install sherpa-onnx numpy
export SHERPA_TTS_DIR=/path/to/vits-piper-en_US-amy-low      # builds the sample talk
export SHERPA_ASR_DIR=/path/to/sherpa-onnx-streaming-zipformer-en-20M
export E2E_KEEP_DIR=/tmp/videocraft-e2e                        # optional: keep outputs + summary.json
npm run build && node --test test/e2e/pipeline.e2e.test.mjs
```

`sherpa_worker.py` is a test-only stand-in for `workers/transcription/worker.py` with the same JSON-lines
protocol. `make_sample.py` synthesises a 60s talk with on- and off-topic sentences plus ground truth.

## Verified here vs. not verified

Verified by this test and the package suites: upload validation, transcription plumbing, silence detection,
highlight scoring and explanations, timeline edits (ripple, reorder, trim, captions follow cuts), caption
correction, platform renders with burned-in captions, playable output.

Also verified in the package suites: face-aware reframing (needs OpenCV 4.x with Haar cascades; the test skips
where they are missing), loudness normalisation measured with EBU R128, shot-change detection, edge snapping.

Not verified in this environment: the production faster-whisper worker, Docker image builds, the Postgres/Redis
backed queue and render-worker path, deployment to the staging server, in-browser H.264 playback, the LLM re-ranker against a real provider (tested against a local mock of the API) Postgres migration 005 (preferences) against a real database, and motion graphics (not built).
