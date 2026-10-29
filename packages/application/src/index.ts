import type { Asset, PreferenceRepository, PreferenceSample, Project, ProjectRevision, Timeline, UUID } from "@videocraft/domain";
import { validateTimeline } from "@videocraft/domain";

export interface Clock { now(): string; }
export interface IdFactory { next(): UUID; }
export interface ProjectRepository { get(id: UUID): Promise<Project | undefined>; listForOwner(ownerId: UUID): Promise<Project[]>; save(project: Project): Promise<void>; /** Deletes the project and everything recorded about it (assets, revisions, proposals, renders, members). */ delete?(id: UUID): Promise<void>; }
export interface AssetRepository { listForProject(projectId: UUID): Promise<Asset[]>; /** Every stored object an asset owns (original and derived files such as playback proxies). */ listStorageKeys(): Promise<string[]>; save(asset: Asset): Promise<void>; /** Replaces an asset's metadata (derived-file status and keys). */ updateMetadata?(assetId: UUID, metadata: Asset["metadata"]): Promise<void>; /** For stores without cascading deletes (the database cascades from the project). */ deleteForProject?(projectId: UUID): Promise<void>; }
export interface SceneRecord { id: string; assetId: UUID; startUs: number; endUs: number; createdAt: string; }
export interface SceneRepository {
  listForAsset(assetId: UUID): Promise<SceneRecord[]>;
  replaceForAsset(assetId: UUID, scenes: SceneRecord[]): Promise<void>;
}
export type ProjectMemberRole = "editor" | "viewer";
export interface ProjectMember { projectId: UUID; userId: UUID; role: ProjectMemberRole; createdAt: string; }
export interface ProjectMemberRepository {
  listForProject(projectId: UUID): Promise<ProjectMember[]>;
  upsert(member: ProjectMember): Promise<void>;
  remove(projectId: UUID, userId: UUID): Promise<void>;
}
export interface RevisionRepository { get(projectId: UUID, revision: number): Promise<ProjectRevision | undefined>; save(revision: ProjectRevision): Promise<void>; }

export interface CreateProjectInput { ownerId: UUID; name: string; }
export interface SaveRevisionInput {
  projectId: UUID;
  createdBy: UUID;
  timeline: Timeline;
  tailoring?: NonNullable<ProjectRevision["tailoring"]>;
  acceptedProposalIds?: UUID[];
}

/** A person already has a project with this name (compared ignoring case and repeated spaces). */
export class ProjectNameTakenError extends Error {
  readonly code = "project_name_taken";
  constructor(readonly projectName: string) { super("You already have a project called \"" + projectName + "\". Choose a different name."); }
}
/** Trims and collapses whitespace; the stored form of a project name. */
export function normalizeProjectName(name: string): string { return name.trim().replace(/\s+/g, " "); }
/** The form compared for uniqueness. */
export function projectNameKey(name: string): string { return normalizeProjectName(name).toLowerCase(); }

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly assets: AssetRepository,
    private readonly revisions: RevisionRepository,
    private readonly ids: IdFactory,
    private readonly clock: Clock,
  ) {}

  async createProject(input: CreateProjectInput): Promise<Project> {
    const name = normalizeProjectName(input.name);
    if (!name) throw new Error("Project name is required");
    if (name.length > 120) throw new Error("Project name is too long");
    await this.requireUniqueName(input.ownerId, name);
    const timestamp = this.clock.now();
    const project: Project = { id: this.ids.next(), ownerId: input.ownerId, name, revision: 0, createdAt: timestamp, updatedAt: timestamp };
    await this.projects.save(project);
    return project;
  }

  async renameProject(projectId: UUID, name: string): Promise<Project> {
    const project = await this.requireProject(projectId);
    const normalizedName = normalizeProjectName(name);
    if (!normalizedName) throw new Error("Project name is required");
    if (normalizedName.length > 120) throw new Error("Project name is too long");
    await this.requireUniqueName(project.ownerId, normalizedName, project.id);
    const renamed = { ...project, name: normalizedName, updatedAt: this.clock.now() };
    await this.projects.save(renamed);
    return renamed;
  }

  private async requireUniqueName(ownerId: UUID, name: string, exceptProjectId?: UUID): Promise<void> {
    const key = projectNameKey(name);
    const clash = (await this.projects.listForOwner(ownerId)).find((existing) => existing.id !== exceptProjectId && projectNameKey(existing.name) === key);
    if (clash) throw new ProjectNameTakenError(clash.name);
  }

  async addAsset(asset: Asset): Promise<void> {
    const project = await this.requireProject(asset.projectId);
    if (!/^[a-f0-9]{64}$/i.test(asset.checksumSha256)) throw new Error("Asset checksum must be a SHA-256 hex digest");
    const expectedPrefix = "projects/" + project.id + "/assets/";
    if (!asset.storageKey.startsWith(expectedPrefix) || !asset.storageKey.slice(expectedPrefix.length) || asset.storageKey.includes("\0")) {
      throw new Error("Asset storage key must be scoped to the project");
    }
    await this.assets.save(asset);
    await this.projects.save({ ...project, updatedAt: this.clock.now() });
  }

  async saveRevision(input: SaveRevisionInput): Promise<ProjectRevision> {
    const project = await this.requireProject(input.projectId);
    validateTimeline(input.timeline);
    const assets = new Set((await this.assets.listForProject(project.id)).map((asset) => asset.id));
    for (const clip of input.timeline.tracks.flatMap((track) => track.clips)) {
      if (!assets.has(clip.assetId) && !clip.assetId.startsWith("generated:")) {
        throw new Error("Timeline references an asset outside the project");
      }
    }

    const nextRevision = project.revision + 1;
    const revision: ProjectRevision = {
      projectId: project.id,
      revision: nextRevision,
      timeline: input.timeline,
      ...(input.tailoring === undefined ? {} : { tailoring: input.tailoring }),
      acceptedProposalIds: input.acceptedProposalIds ?? [],
      createdAt: this.clock.now(),
      createdBy: input.createdBy,
    };
    await this.revisions.save(revision);
    await this.projects.save({ ...project, revision: nextRevision, updatedAt: revision.createdAt });
    return revision;
  }

  private async requireProject(id: UUID): Promise<Project> {
    const project = await this.projects.get(id);
    if (!project) throw new Error("Project not found");
    return project;
  }
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly values = new Map<UUID, Project>();
  async get(id: UUID) { return this.values.get(id); }
  async listForOwner(ownerId: UUID) { return [...this.values.values()].filter((project) => project.ownerId === ownerId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); }
  async save(project: Project) {
    // Mirrors the database's unique index on (owner, normalised name).
    const clash = [...this.values.values()].find((existing) => existing.id !== project.id && existing.ownerId === project.ownerId && projectNameKey(existing.name) === projectNameKey(project.name));
    if (clash) throw new ProjectNameTakenError(clash.name);
    this.values.set(project.id, project);
  }
  async delete(id: UUID) { this.values.delete(id); }
}
export class InMemoryAssetRepository implements AssetRepository {
  private readonly values = new Map<UUID, Asset>();
  async listForProject(projectId: UUID) { return [...this.values.values()].filter((asset) => asset.projectId === projectId); }
  async listStorageKeys() { return [...this.values.values()].flatMap((asset) => [asset.storageKey, ...(typeof asset.metadata.proxyKey === "string" ? [asset.metadata.proxyKey] : [])]); }
  async save(asset: Asset) { this.values.set(asset.id, asset); }
  async updateMetadata(assetId: UUID, metadata: Asset["metadata"]) { const asset = this.values.get(assetId); if (asset) this.values.set(assetId, { ...asset, metadata }); }
  async deleteForProject(projectId: UUID) { for (const [id, asset] of this.values) if (asset.projectId === projectId) this.values.delete(id); }
}
export class InMemoryRevisionRepository implements RevisionRepository {
  private readonly values = new Map<string, ProjectRevision>();
  async get(projectId: UUID, revision: number) { return this.values.get(projectId + ":" + revision); }
  async save(value: ProjectRevision) { this.values.set(value.projectId + ":" + value.revision, value); }
}


export class InMemoryProjectMemberRepository implements ProjectMemberRepository {
  private readonly values = new Map<string, ProjectMember>();
  async listForProject(projectId: UUID) {
    return [...this.values.values()].filter((member) => member.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.userId.localeCompare(b.userId));
  }
  async upsert(member: ProjectMember) { this.values.set(member.projectId + ":" + member.userId, member); }
  async remove(projectId: UUID, userId: UUID) { this.values.delete(projectId + ":" + userId); }
}


export class InMemorySceneRepository implements SceneRepository {
  private readonly values = new Map<string, SceneRecord>();
  async listForAsset(assetId: UUID) {
    return [...this.values.values()].filter((scene) => scene.assetId === assetId)
      .sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id));
  }
  async replaceForAsset(assetId: UUID, scenes: SceneRecord[]) {
    for (const key of [...this.values.keys()]) if (key.startsWith(assetId + ":")) this.values.delete(key);
    for (const scene of scenes) {
      if (scene.assetId !== assetId || scene.endUs <= scene.startUs) throw new Error("Invalid scene record");
      this.values.set(assetId + ":" + scene.id, scene);
    }
  }
}

/** In-memory preference store (tests and single-process setups). */
export class InMemoryPreferenceRepository implements PreferenceRepository {
  private readonly values = new Map<string, PreferenceSample>();
  async append(samples: PreferenceSample[]) { for (const sample of samples) if (!this.values.has(sample.key)) this.values.set(sample.key, sample); }
  async list(userId: UUID, strategyId: string, limit: number) { return [...this.values.values()].filter((s) => s.userId === userId && s.strategyId === strategyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit); }
  async clear(userId: UUID) { for (const [key, sample] of this.values) if (sample.userId === userId) this.values.delete(key); }
}
