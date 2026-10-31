# Creative treatments and the growing library

Visuals → Creative treatments offers original procedural recipes across motion, typography, reactions, sound and transitions. The starter catalogue has eight treatments. A recipe combines its base treatment with text, colour, duration, optional quiet sound and optional clip motion. These combinations can be saved and reused across projects on the same account. No source footage, likeness or third-party media bytes are copied into the library. Accepted Pexels/Pixabay stock imports also save reusable provider references. Reusing a stock treatment imports that provider item into the destination project through the existing validated, bounded download path; the importer reuses an existing copy in that project. Actual imported assets keep their provider credit and source page. GIFs are not added to this reusable pool.

## Creator workflow

Select words, a clip or a moment in the edited preview, choose a treatment, adjust its controls and add it. The edit is an ordinary revision with Undo support. A graphic must fit the remaining portion of its host clip; choose an earlier moment or shorten it if it does not. Motion applies across the host clip and transitions affect its entrance. Source-time anchors include the clip occurrence, so a repeated segment receives the effect only once.

Save treatment stores the recipe without changing the timeline. Add treatment saves it after the edit succeeds when the remember checkbox is enabled. A failed library save leaves the successful edit intact and offers a separate save retry. Saved treatments survive project switches and reloads. Deleting one from the library does not remove it from existing edits. The library shows the 100 most recently saved recipes; saving an identical normalised recipe updates its timestamp rather than duplicating it.

## Director workflow

The existing single-source AI Director can propose creative `effect` suggestions with a specific reason and source time. It receives the account's 24 most recently saved recipes and can reuse them or compose variations from supported primitives. It may propose at most three treatments, spaced at least four source seconds apart. Effects are compiled after the cut and are omitted if the cited moment was removed or has less than one second remaining. Accepted, successfully applied recipes are saved to that account. Merely requesting a plan does not save anything. Unknown presets, colours, sounds, motion and out-of-range durations cannot execute arbitrary code or download assets.

Director suggestions remain reviewable. There is no claim that arbitrary creative decisions improve the edit. The rules fallback handles explicitly named starter treatments, while contextual creative choices need the configured AI provider. The mixed-media storyboard Director does not yet propose these treatments automatically; manual library use works on video and photo clips.

## Rendering and provenance

Existing FFmpeg paths render callouts, titles, quiet generated sounds, punch/slow push and dissolves. Decorative equation graphics use a deterministic layout shared by the browser and ASS renderer, including staggered entrances, drift, rotation and fades. They are decorative symbols, not factual annotations. Titles and callouts share placement, face/caption clearance and scale calculations across preview and ASS, with matching accent boxes, white lettering and seek-driven entrance/fade timing. Preview remains an approximation of font metrics and the exported composition.

The library is stored in PostgreSQL `effect_library`, keyed by authenticated owner and a hash of a validated, normalised recipe. All routes authenticate and derive ownership from the session. Migration 008 is additive. The pinned release script runs migrations before replacing app containers and aborts with the old apps still running if migration fails. No new paid provider is needed for built-in treatments. Stock import and generated imagery remain separate existing flows with their own provenance.

## Verification and remaining scope

Tests cover recipe validation, repeated-clip anchors, Director density and retained-moment checks, accepted-only saving, stale revisions, owner isolation, persistence and deletion. Real FFmpeg tests render every starter treatment in portrait, square and landscape and decode every file. Browser tests cover composition, preview, reload reuse, deletion and recovery after library outages, in Chromium and mobile WebKit.

Still outside this version: an arbitrary downloadable effect-asset catalogue beyond the existing Pexels/Pixabay provider paths, automatic video generation, licensing review for new third-party providers, arbitrary custom motion-graphic code, richer annotation primitives, beat-aware placement, automatic treatments in mixed-media storyboards, physical-device approval and an aesthetic benchmark with human review. Do not label the whole product production-ready from this feature's test results.
