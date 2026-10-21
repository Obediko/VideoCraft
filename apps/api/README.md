# VideoCraft API

The API is an authenticated Fastify boundary for projects, revisions, assets, transcripts, intent analysis, proposals, feedback, and renders. Request handlers authorize project access, validate provider output, and enqueue long-running work without calling media or AI providers directly.

Implemented project lifecycle endpoints include:

- `GET /healthz` and dependency-aware `GET /readyz`
- `GET /metrics`
- `GET /v1/projects` and `GET /v1/projects/:projectId`
- `POST /v1/projects`
- `GET /v1/projects/:projectId/revisions/:revision`
- `POST /v1/projects/:projectId/revisions`

All project-scoped responses require authentication and the appropriate viewer/editor authorization. Long-running transcription and rendering remain provider/queue adapters behind explicit ports.
