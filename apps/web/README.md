# VideoCraft web editor

The first web surface provides:

- bearer-token configuration;
- project creation;
- tailoring brief entry;
- non-destructive timeline state;
- revision save;
- explainable proposal preview;
- proposal accept/reject;
- render submission.

Run it with Vite and set VITE_API_BASE_URL when the API is not on http://localhost:8080.

The current surface intentionally requires a registered asset ID because multipart upload, signed object storage, playback, keyboard editing, and render-status polling are follow-up slices. Automated changes remain visible and reversible.
