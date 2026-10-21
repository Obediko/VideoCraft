# Security model

The API boundary requires an injected Authenticator and ProjectAuthorizer. There is no insecure default identity, and the server returns 401 when authentication is absent and 403 when the authenticated principal lacks project access.

Project-scoped writes always derive the project ID from the route and the user ID from the authenticated principal. Client payloads cannot choose the owner of a project or write to a different project through an asset or revision body.

The API applies a one-megabyte JSON body limit. Media bytes must be uploaded through a future signed object-storage flow; they must not pass through these JSON endpoints.

Production integration must provide a real token verifier, project membership lookup, CSRF protection where cookie authentication is used, rate limiting, request IDs, structured audit events, and a database transaction around revision creation. The current boundary makes those requirements explicit without pretending an in-memory or anonymous implementation is secure.
