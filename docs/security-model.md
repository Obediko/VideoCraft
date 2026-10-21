# Security model

The API boundary requires an injected Authenticator and ProjectAuthorizer. There is no insecure default identity, and the server returns 401 when authentication is absent and 403 when the authenticated principal lacks project access.

Project-scoped writes derive the project ID from the route and the user ID from the authenticated principal. Client payloads cannot choose the owner of a project or write to a different project through an asset or revision body.

JSON requests are limited to one megabyte. Multipart uploads are separately bounded at two gigabytes, written to a temporary file, checksummed, and moved atomically into a project-scoped storage key before the asset record is created. Render playback uses five-minute HMAC-signed URLs so browser media elements do not receive bearer tokens.

Production integration must still provide provider-native object storage, malware scanning, request IDs, structured audit events, CSRF protection where cookie authentication is used, per-user/provider rate limits, and database transactions around revision and transcript replacement. The current branch makes those requirements explicit without presenting local adapters as production infrastructure.
