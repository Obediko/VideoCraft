# VideoCraft architecture

## System shape

Start as a modular monolith with explicit ports. The web editor talks to an authenticated API. The API orchestrates use cases and queues long-running transcription and rendering work. Workers use storage and provider adapters. The web application never calls providers directly.

## Core concepts

- Project: user-owned workspace with immutable revision history.
- Asset: immutable source or derived media object.
- Transcript: timestamped, confidence-bearing words and segments with provenance.
- Timeline: tracks and clips that reference assets.
- Tailoring profile: intent, audience, channel, duration, tone, and constraints.
- Strategy: named and versioned editing policy.
- Proposal: explainable suggested operations awaiting human review.
- Render job: reproducible request for a specific revision and settings.
- Feedback event: acceptance, rejection, edit, export, or share signal.

## Tailoring and learning loop

1. The creator supplies intent and audience context.
2. Intent analysis returns structured context plus evidence.
3. A versioned strategy returns candidate operations.
4. The user accepts, rejects, or edits a proposal.
5. Feedback is stored with the revision, strategy, and provider metadata.
6. Offline evaluation measures strategy quality against reviewed outcomes.
7. Any future model update is a separate, explicitly governed training or evaluation process.

This is feedback-driven product learning, not a claim that the production model retrains itself after every edit.

## Tradeoffs

- Modular monolith first reduces deployment complexity while contracts evolve; ports preserve a path to workers and services.
- Immutable revisions cost storage and explicit version handling, but enable undo, auditability, reproducible renders, and reliable feedback attribution.
- Proposal-based AI adds review UX, but prevents surprising destructive edits and makes evaluation possible.
- Provider ports add boundary code, but avoid coupling the product to one AI, transcription vendor, or media runtime.
- A JSON-friendly timeline is interoperable, but validation must remain strict.

## Planned persistence

Use a relational store for projects, memberships, revisions, assets, transcripts, tailoring profiles, strategies, proposals, render jobs, feedback, and evaluation runs. Store large media and outputs in object storage with checksums and access-controlled references in the database.
