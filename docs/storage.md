# Storage boundary

VideoCraft stores media outside the database. The database keeps an immutable object key, checksum, size, and metadata.

The local adapter is intended for development and worker tests. Production should replace it with an object-storage adapter that provides private buckets, server-side encryption, multipart upload, checksum verification, lifecycle retention, and short-lived signed URLs.

Object keys are always resolved under a configured root. Uploads use a temporary file and an atomic rename, and callers must validate media type and size before registering the asset.
