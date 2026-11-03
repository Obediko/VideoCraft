# Premium effects catalogue

VideoCraft's premium catalogue is curated rather than an unbounded template dump. The ordinary editor exposes a small, story-safe set; a future Advanced library may expose a broader allowlisted collection after render, licence and device checks.

## First compatibility layer

Six premium transitions are implemented through FFmpeg's maintained `xfade` filter and approximated in the browser preview:

| VideoCraft treatment | FFmpeg implementation | Intended use |
| --- | --- | --- |
| Soft pan | `smoothleft` | Restrained directional scene change |
| Soft rise | `smoothup` | Progress, arrival or an upward reveal |
| Match push | `zoomin` | Aligned then-and-now or detail-to-detail imagery |
| Film fade | `fadeslow` | Passage of time or feeling |
| Silver fade | `fadegrays` | Archival or reflective memory beat |
| Editorial cover | `coverleft` | Confident chapter change with matched movement |

These techniques overlap adjacent pictures without moving the edit. Transition duration remains bounded by half of either shot, and final Check flags excessive or overlong use. The Director sees intended-use guidance and should normally select no more than one visible transition at a real story turn.

FFmpeg is already part of the render worker and is governed by its deployed build and licence. The names above use FFmpeg's documented `xfade` implementations; no third-party shader source is executed.

## External catalogue evaluation

[GL Transitions](https://github.com/gl-transitions/gl-transitions) is the leading candidate for the larger Advanced library. Its catalogue contains more than 100 parameterised transitions with per-transition licence metadata and automated multi-target render comparisons. Enabling its shaders in production requires a dedicated, sandboxed shader renderer, deterministic CPU/GPU fallback, preview/export parity, per-transition allowlisting and container benchmarks. Merely listing a shader that the export worker cannot reproduce is not acceptable.

Depth-based parallax and face morphing remain separate processing services. They require downloaded models/native dependencies, resource quotas, failure recovery and provenance. A real-person face morph must also require an explicit creator action and confirmation that the creator has permission to transform both images. Passage dissolve remains the non-generative alternative.

## Acceptance gates

Before another external effect enters the default catalogue it must have:

- a compatible commercial-use licence recorded in the repository;
- bounded parameters and no arbitrary code or remote asset execution;
- a matching live-preview implementation or a clear preview limitation;
- real FFmpeg/worker output tests at portrait, square and landscape sizes;
- decode, duration and black-frame checks;
- an editorial-use description so the Director can prefer a clean cut when the effect is not motivated;
- acceptable CPU, GPU and memory measurements in the staging container.

