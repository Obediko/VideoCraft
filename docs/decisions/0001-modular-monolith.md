# ADR 0001: Start as a modular monolith

- Status: accepted
- Date: 2026-10-21

## Context

VideoCraft needs a web editor, AI-assisted analysis, long-running media work, and durable project history. The domain and provider contracts are not stable enough to justify multiple deployable services.

## Decision

Start with a modular monolith containing explicit domain, application, adapter, and interface boundaries. Run transcription and rendering through worker processes behind queue and storage ports when those flows are implemented.

## Consequences

Benefits include one local development path, faster iteration, framework-independent domain tests, and a clear path to extraction later. The cost is that module boundaries must be enforced by review and tooling and that the first deployment may contain more than one runtime process.

Revisit this decision when throughput, team ownership, or failure isolation justifies separate services.
