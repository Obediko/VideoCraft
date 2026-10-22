# Real-media pipeline test

`pipeline.e2e.test.mjs` runs the real API stack (real HTTP server, real ffprobe / ffmpeg adapters, real
FFmpeg renderer) against a real video file and checks the outputs, not just the responses.

Flow: upload (junk and audio-only files rejected) → transcript with word timestamps → silence detection →
`highlight-reel` proposal (relevance to the stated goal, timestamped transcript evidence) → accept → edit
(insert/trim, reorder, caption correction) → render TikTok 9:16, YouTube 16:9 and no-caption variants.
Renders are checked with ffprobe (dimensions, duration), a full decode, an SSIM check of the caption band, and
a re-transcription of the exported audio (must contain the on-topic content and none of the cut content).

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

Not verified in this environment: the production faster-whisper worker, Docker image builds, the Postgres/Redis
backed queue and render-worker path, deployment to the staging server, face-aware reframing (render uses a
centre crop), LLM-based scoring (scoring is heuristic and deterministic), learning from feedback (feedback is
stored only), B-roll, music and motion graphics.
