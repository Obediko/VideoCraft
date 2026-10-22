export interface AuditEventRecord {
  id: string;
  actorId?: string;
  projectId?: string;
  action: string;
  method: string;
  route: string;
  statusCode: number;
  requestId: string;
  metadata?: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface AuditDatabase {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export class PostgresAuditRepository {
  constructor(private readonly db: AuditDatabase) {}

  async append(event: AuditEventRecord): Promise<void> {
    await this.db.query(
      "INSERT INTO audit_events (id, actor_id, project_id, action, method, route, status_code, request_id, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [event.id, event.actorId ?? null, event.projectId ?? null, event.action, event.method, event.route, event.statusCode, event.requestId, JSON.stringify(event.metadata ?? {}), event.createdAt],
    );
  }
}
