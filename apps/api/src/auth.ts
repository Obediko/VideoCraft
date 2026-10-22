import { jwtVerify, type JWTVerifyOptions } from "jose";
import type { FastifyRequest } from "fastify";
import type { UUID } from "@videocraft/domain";
import type { Database, PostgresProjectRepository } from "@videocraft/persistence";
import type { Authenticator, Principal, ProjectAuthorizer } from "./server.js";

export class JwtAuthenticator implements Authenticator {
  private readonly secrets: Uint8Array[];
  private readonly options: JWTVerifyOptions;

  constructor(secret: string | readonly string[], options: { issuer?: string; audience?: string } = {}) {
    const values = typeof secret === "string" ? [secret] : [...secret];
    if (values.length === 0 || values.some((value) => value.length < 32)) throw new Error("Every AUTH_JWT_SECRET value must be at least 32 characters");
    this.secrets = values.map((value) => new TextEncoder().encode(value));
    this.options = {
      ...(options.issuer ? { issuer: options.issuer } : {}),
      ...(options.audience ? { audience: options.audience } : {}),
    };
  }

  async authenticate(request: FastifyRequest): Promise<Principal | null> {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    for (const secret of this.secrets) {
      try {
        const { payload } = await jwtVerify(header.slice(7), secret, this.options);
        return typeof payload.sub === "string" && payload.sub.length > 0 ? { userId: payload.sub } : null;
      } catch {
        // Try the next active signing secret during an overlap rotation window.
      }
    }
    return null;
  }
}

export class PostgresProjectAuthorizer implements ProjectAuthorizer {
  constructor(
    private readonly projects: PostgresProjectRepository,
    private readonly db: Database,
  ) {}

  async canAccess(principal: Principal, projectId: UUID, minimumRole: "viewer" | "editor"): Promise<boolean> {
    const project = await this.projects.get(projectId);
    if (!project) return false;
    if (project.ownerId === principal.userId) return true;

    const result = await this.db.query<{ role: "owner" | "editor" | "viewer" }>(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
      [projectId, principal.userId],
    );
    const role = result.rows[0]?.role;
    if (!role) return false;
    return minimumRole === "viewer"
      ? role === "viewer" || role === "editor" || role === "owner"
      : role === "editor" || role === "owner";
  }
}
