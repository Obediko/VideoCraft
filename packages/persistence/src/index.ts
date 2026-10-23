import { Pool, type PoolConfig } from "pg";
import type { Asset, EditingProposal, Project, ProjectRevision, TranscriptSegment, UUID } from "@videocraft/domain";
import type { AssetRepository, ProjectMember, ProjectMemberRepository, ProjectRepository, RevisionRepository, SceneRecord, SceneRepository } from "@videocraft/application";

export interface Database {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
  transaction?<T>(work: (database: Database) => Promise<T>): Promise<T>;
}
export interface TranscriptStore {
  listForAsset(assetId: UUID): Promise<TranscriptSegment[]>;
  replaceForAsset(assetId: UUID, segments: TranscriptSegment[]): Promise<void>;
}
export interface ProposalStore {
  save(proposal: EditingProposal): Promise<void>;
  get(id: UUID): Promise<EditingProposal | undefined>;
  setStatus(id: UUID, status: EditingProposal["status"]): Promise<void>;
}
export function createPool(config: PoolConfig | string): Pool {
  return new Pool(typeof config === "string" ? { connectionString: config } : config);
}

export function createDatabase(pool: Pool): Database {
  return {
    query: <T = Record<string, unknown>>(text: string, values?: readonly unknown[]) => pool.query(text, values as unknown[] | undefined) as unknown as Promise<{ rows: T[] }>,
    transaction: async <T>(work: (database: Database) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      const database: Database = {
        query: <T = Record<string, unknown>>(text: string, values?: readonly unknown[]) => client.query(text, values as unknown[] | undefined) as unknown as Promise<{ rows: T[] }>,
      };
      try {
        await client.query("BEGIN");
        const result = await work(database);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly db: Database) {}
  async get(id: UUID): Promise<Project | undefined> {
    const result = await this.db.query<ProjectRow>("SELECT id, owner_id, name, revision, created_at, updated_at FROM projects WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? mapProject(row) : undefined;
  }
  async listForOwner(ownerId: UUID): Promise<Project[]> {
    const result = await this.db.query<ProjectRow>("SELECT id, owner_id, name, revision, created_at, updated_at FROM projects WHERE owner_id = $1 ORDER BY created_at, id", [ownerId]);
    return result.rows.map(mapProject);
  }
  async save(project: Project): Promise<void> {
    await this.db.query(
      "INSERT INTO projects (id, owner_id, name, revision, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6) " +
      "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at",
      [project.id, project.ownerId, project.name, project.revision, project.createdAt, project.updatedAt],
    );
  }
}

export class PostgresSceneRepository implements SceneRepository {
  constructor(private readonly db: Database) {}
  async listForAsset(assetId: UUID): Promise<SceneRecord[]> {
    const result = await this.db.query<SceneRow>(
      "SELECT id, asset_id, start_us, end_us, created_at FROM scenes WHERE asset_id = $1 ORDER BY start_us, id",
      [assetId],
    );
    return result.rows.map((row) => ({ id: row.id, assetId: row.asset_id, startUs: Number(row.start_us), endUs: Number(row.end_us), createdAt: row.created_at }));
  }
  async replaceForAsset(assetId: UUID, scenes: SceneRecord[]): Promise<void> {
    const replace = async (database: Database): Promise<void> => {
      for (const scene of scenes) {
        if (scene.assetId !== assetId || scene.endUs <= scene.startUs) throw new Error("Invalid scene record");
      }
      await database.query("DELETE FROM scenes WHERE asset_id = $1", [assetId]);
      for (const scene of scenes) {
        await database.query(
          "INSERT INTO scenes (id, asset_id, start_us, end_us, created_at) VALUES ($1, $2, $3, $4, $5)",
          [scene.id, assetId, scene.startUs, scene.endUs, scene.createdAt],
        );
      }
    };
    if (this.db.transaction) return this.db.transaction(replace);
    return replace(this.db);
  }
}

export class PostgresProjectMemberRepository implements ProjectMemberRepository {
  constructor(private readonly db: Database) {}
  async listForProject(projectId: UUID): Promise<ProjectMember[]> {
    const result = await this.db.query<ProjectMemberRow>(
      "SELECT project_id, user_id, role, created_at FROM project_members WHERE project_id = $1 AND role <> 'owner' ORDER BY created_at, user_id",
      [projectId],
    );
    return result.rows.map(mapProjectMember);
  }
  async upsert(member: ProjectMember): Promise<void> {
    await this.db.query(
      "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES ($1, $2, $3, $4) " +
      "ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role",
      [member.projectId, member.userId, member.role, member.createdAt],
    );
  }
  async remove(projectId: UUID, userId: UUID): Promise<void> {
    await this.db.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 AND role <> 'owner'", [projectId, userId]);
  }
}

export class PostgresAssetRepository implements AssetRepository {
  constructor(private readonly db: Database) {}
  async listForProject(projectId: UUID): Promise<Asset[]> {
    const result = await this.db.query<AssetRow>("SELECT id, project_id, kind, storage_key, checksum_sha256, duration_us, metadata, created_at FROM assets WHERE project_id = $1 ORDER BY created_at, id", [projectId]);
    return result.rows.map(mapAsset);
  }
  async listStorageKeys(): Promise<string[]> {
    const result = await this.db.query<{ storage_key: string; proxy_key: string | null }>("SELECT storage_key, metadata->>'proxyKey' AS proxy_key FROM assets");
    return result.rows.flatMap((row) => row.proxy_key ? [row.storage_key, row.proxy_key] : [row.storage_key]);
  }
  async save(asset: Asset): Promise<void> {
    await this.db.query(
      "INSERT INTO assets (id, project_id, kind, storage_key, checksum_sha256, duration_us, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [asset.id, asset.projectId, asset.kind, asset.storageKey, asset.checksumSha256, asset.durationUs ?? null, JSON.stringify(asset.metadata), asset.createdAt],
    );
  }
  async updateMetadata(assetId: UUID, metadata: Asset["metadata"]): Promise<void> {
    await this.db.query("UPDATE assets SET metadata = $2 WHERE id = $1", [assetId, JSON.stringify(metadata)]);
  }
}

export class PostgresRevisionRepository implements RevisionRepository {
  constructor(private readonly db: Database) {}
  async get(projectId: UUID, revision: number): Promise<ProjectRevision | undefined> {
    const result = await this.db.query<RevisionRow>("SELECT project_id, revision, timeline, tailoring, accepted_proposal_ids, created_at, created_by FROM project_revisions WHERE project_id = $1 AND revision = $2", [projectId, revision]);
    const row = result.rows[0];
    return row ? mapRevision(row) : undefined;
  }
  async save(value: ProjectRevision): Promise<void> {
    await this.db.query(
      "INSERT INTO project_revisions (project_id, revision, timeline, tailoring, accepted_proposal_ids, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [value.projectId, value.revision, JSON.stringify(value.timeline), value.tailoring ? JSON.stringify(value.tailoring) : null, JSON.stringify(value.acceptedProposalIds), value.createdAt, value.createdBy],
    );
  }
}

export class PostgresTranscriptStore implements TranscriptStore {
  constructor(private readonly db: Database) {}
  async listForAsset(assetId: UUID): Promise<TranscriptSegment[]> {
    const result = await this.db.query<TranscriptRow>(
      "SELECT id, asset_id, start_us, end_us, text, words, provider, provider_version FROM transcript_segments WHERE asset_id = $1 ORDER BY start_us, id",
      [assetId],
    );
    return result.rows.map((row) => ({
      id: row.id, assetId: row.asset_id, startUs: Number(row.start_us), endUs: Number(row.end_us),
      text: row.text, words: row.words, provider: row.provider,
      ...(row.provider_version === null ? {} : { providerVersion: row.provider_version }),
    }));
  }
  async replaceForAsset(assetId: UUID, segments: TranscriptSegment[]): Promise<void> {
    await this.db.query("DELETE FROM transcript_segments WHERE asset_id = $1", [assetId]);
    for (const segment of segments) {
      if (segment.assetId !== assetId) throw new Error("Transcript asset mismatch");
      await this.db.query(
        "INSERT INTO transcript_segments (id, asset_id, start_us, end_us, text, words, provider, provider_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [segment.id, assetId, segment.startUs, segment.endUs, segment.text, JSON.stringify(segment.words), segment.provider, segment.providerVersion ?? null],
      );
    }
  }
}

export class PostgresProposalStore implements ProposalStore {
  constructor(private readonly db: Database) {}
  async save(proposal: EditingProposal): Promise<void> {
    await this.db.query(
      "INSERT INTO editing_proposals (id, project_id, base_revision, strategy_id, strategy_version, rationale, confidence, evidence, operations, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [proposal.id, proposal.projectId, proposal.baseRevision, proposal.strategyId, proposal.strategyVersion, proposal.rationale, proposal.confidence, JSON.stringify(proposal.evidence), JSON.stringify(proposal.operations), proposal.status],
    );
  }
  async get(id: UUID): Promise<EditingProposal | undefined> {
    const result = await this.db.query<ProposalRow>(
      "SELECT id, project_id, base_revision, strategy_id, strategy_version, rationale, confidence, evidence, operations, status FROM editing_proposals WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id, projectId: row.project_id, baseRevision: row.base_revision,
      strategyId: row.strategy_id, strategyVersion: row.strategy_version,
      rationale: row.rationale, confidence: row.confidence,
      evidence: row.evidence, operations: row.operations, status: row.status,
    } : undefined;
  }
  async setStatus(id: UUID, status: EditingProposal["status"]): Promise<void> {
    await this.db.query("UPDATE editing_proposals SET status = $2 WHERE id = $1", [id, status]);
  }
}

type ProposalRow = { id: string; project_id: string; base_revision: number; strategy_id: string; strategy_version: string; rationale: string; confidence: number; evidence: EditingProposal["evidence"]; operations: EditingProposal["operations"]; status: EditingProposal["status"] };
type ProjectRow = { id: string; owner_id: string; name: string; revision: number; created_at: string; updated_at: string };
type ProjectMemberRow = { project_id: string; user_id: string; role: "editor" | "viewer"; created_at: string };
type SceneRow = { id: string; asset_id: string; start_us: string; end_us: string; created_at: string };
type AssetRow = { id: string; project_id: string; kind: Asset["kind"]; storage_key: string; checksum_sha256: string; duration_us: string | null; metadata: Record<string, string | number | boolean>; created_at: string };
type RevisionRow = { project_id: string; revision: number; timeline: ProjectRevision["timeline"]; tailoring: NonNullable<ProjectRevision["tailoring"]> | null; accepted_proposal_ids: UUID[]; created_at: string; created_by: string };
type TranscriptRow = { id: string; asset_id: string; start_us: string; end_us: string; text: string; words: TranscriptSegment["words"]; provider: string; provider_version: string | null };

function mapProject(row: ProjectRow): Project {
  return { id: row.id, ownerId: row.owner_id, name: row.name, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapProjectMember(row: ProjectMemberRow): ProjectMember {
  return { projectId: row.project_id, userId: row.user_id, role: row.role, createdAt: row.created_at };
}
function mapAsset(row: AssetRow): Asset {
  return { id: row.id, projectId: row.project_id, kind: row.kind, storageKey: row.storage_key, checksumSha256: row.checksum_sha256, ...(row.duration_us === null ? {} : { durationUs: Number(row.duration_us) }), metadata: row.metadata, createdAt: row.created_at };
}
function mapRevision(row: RevisionRow): ProjectRevision {
  return { projectId: row.project_id, revision: row.revision, timeline: row.timeline, ...(row.tailoring === null ? {} : { tailoring: row.tailoring }), acceptedProposalIds: row.accepted_proposal_ids, createdAt: row.created_at, createdBy: row.created_by };
}

export { PostgresRenderJobRepository } from "./render-jobs.js";

export { PostgresFeedbackRepository } from "./feedback.js";
export { PostgresPreferenceRepository } from "./preferences.js";

export { PostgresAuditRepository, type AuditEventRecord } from "./audit.js";

export { migrateDatabase } from "./migration-runner.js";
