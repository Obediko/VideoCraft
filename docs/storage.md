# Storage boundary

VideoCraft stores media outside the database. The database keeps an immutable project-scoped object key, checksum, size, and metadata.

The local adapter is used by the current API and worker slice. Multipart uploads are streamed to a temporary file, verified by SHA-256, and atomically moved into the configured root. Completed render outputs are exposed through an authenticated endpoint that issues short-lived HMAC-signed URLs.

Production should replace the local adapter with an object-storage adapter that provides private buckets, server-side encryption, provider multipart upload, checksum verification, lifecycle retention, malware scanning, and provider-native signed URLs. Object keys are always resolved under the configured root or bucket prefix.
