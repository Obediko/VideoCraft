import { randomUUID, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { applyTimelineOperations, validateProposal } from "@videocraft/domain";
import type { Asset, EditingProposal, PreferenceRepository, ProjectRevision, RenderSettings, RendererPort, StrategyRegistry, TailoringProfile, Timeline, TimelineSignals, TranscriptSegment, TranscriptionPort, UUID } from "@videocraft/domain";
import type { SceneDetector } from "@videocraft/scene-detection";
import { exportedSamples, learnedFor, record, rejectedSamples } from "./learning.js";
import { ProjectNameTakenError, ProjectService, type Clock, type IdFactory, type ProjectMemberRepository, type ProjectRepository, type AssetRepository, type RevisionRepository, type SceneRepository } from "@videocraft/application";
import type { ObjectStorage } from "@videocraft/storage";
import { MetricsRegistry } from "@videocraft/observability";

export interface Principal { userId: UUID; }
export interface Authenticator { authenticate(request: FastifyRequest): Promise<Principal | null>; }
export interface ProjectAuthorizer { canAccess(principal: Principal, projectId: UUID, minimumRole: "viewer" | "editor"): Promise<boolean>; }
export interface TranscriptStore {
  replaceForAsset(assetId: UUID, segments: TranscriptSegment[]): Promise<void>;
  listForAsset(assetId: UUID): Promise<TranscriptSegment[]>;
}
export interface ProposalStore {
  save(proposal: EditingProposal): Promise<void>;
  get(id: UUID): Promise<EditingProposal | undefined>;
  setStatus(id: UUID, status: EditingProposal["status"]): Promise<void>;
}
export interface ReadinessCheck { name: string; check(): Promise<boolean>; }
export interface AuditWriter {
  append(event: { id: string; actorId?: string; projectId?: string; action: string; method: string; route: string; statusCode: number; requestId: string; metadata?: Record<string, string | number | boolean>; createdAt: string }): Promise<void>;
}
export interface ApiDependencies {
  projects: ProjectRepository; assets: AssetRepository; revisions: RevisionRepository; members?: ProjectMemberRepository; storage?: ObjectStorage;
  authenticate: Authenticator; authorize: ProjectAuthorizer;
  renderer?: RendererPort; transcriber?: TranscriptionPort; sceneDetector?: SceneDetector; scenes?: SceneRepository; transcripts?: TranscriptStore; preferences?: PreferenceRepository; silenceDetector?: { detect(storageKey: string): Promise<Array<{ startUs: number; endUs: number }>>; detectScenes?(storageKey: string): Promise<Array<{ startUs: number; endUs: number }>> }; strategies?: StrategyRegistry; proposals?: ProposalStore;
  clock?: Clock; ids?: IdFactory; audit?: AuditWriter; metrics?: MetricsRegistry; metricsToken?: string; readiness?: ReadinessCheck[];
}

export function buildServer(dependencies: ApiDependencies): FastifyInstance {
  // Trust X-Forwarded-For only from loopback/private networks (the host reverse proxy), so request.ip is the real client IP for rate limiting.
  const server = Fastify({ logger: true, bodyLimit: 1_000_000, trustProxy: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] });
  const clock = dependencies.clock ?? { now: () => new Date().toISOString() };
  const ids = dependencies.ids ?? { next: () => randomUUID() };
  const metrics = dependencies.metrics ?? new MetricsRegistry();
  const projectService = new ProjectService(dependencies.projects, dependencies.assets, dependencies.revisions, ids, clock);

  server.addHook("onRequest", async (request) => {
    (request as FastifyRequest & { videocraftMetricsStartedAt?: bigint }).videocraftMetricsStartedAt = process.hrtime.bigint();
  });

  server.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? request.url.split("?")[0] ?? "unknown";
    metrics.increment("videocraft_http_requests_total", { method: request.method, route, status: String(reply.statusCode) });
    const started = (request as FastifyRequest & { videocraftMetricsStartedAt?: bigint }).videocraftMetricsStartedAt;
    if (started !== undefined) metrics.observe("videocraft_http_request_duration_ms", Number(process.hrtime.bigint() - started) / 1_000_000, { method: request.method, route });
    if (!dependencies.audit) return;
    const params = asRecord(request.params);
    const principal = (request as FastifyRequest & { videocraftPrincipal?: Principal }).videocraftPrincipal;
    try {
      await dependencies.audit.append({
        id: ids.next(),
        ...(principal ? { actorId: principal.userId } : {}),
        ...(typeof params.projectId === "string" ? { projectId: params.projectId } : {}),
        action: request.routeOptions.url ?? request.url.split("?")[0] ?? "unknown",
        method: request.method,
        route: request.routeOptions.url ?? request.url.split("?")[0] ?? "unknown",
        statusCode: reply.statusCode,
        requestId: request.id,
        createdAt: clock.now(),
      });
    } catch (error) {
      request.log.error({ error }, "audit event persistence failed");
    }
  });

  server.get("/healthz", async () => ({ status: "ok" }));
  server.get("/readyz", async (_request, reply) => {
    for (const dependency of dependencies.readiness ?? []) {
      try {
        if (!(await dependency.check())) return reply.code(503).send({ status: "not_ready", dependency: dependency.name });
      } catch (error) {
        requestLog(reply, error, `readiness check failed: ${dependency.name}`);
        return reply.code(503).send({ status: "not_ready", dependency: dependency.name });
      }
    }
    return { status: "ok" };
  });
  server.get("/metrics", async (request, reply) => {
    if (dependencies.metricsToken && !hasBearerToken(request, dependencies.metricsToken)) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Metrics authentication required" } });
    }
    return reply.type("text/plain; version=0.0.4").send(metrics.renderPrometheus());
  });

  server.get("/v1/projects", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    return { projects: await dependencies.projects.listForOwner(principal.userId) };
  });

  // Deleting a project is for its owner only, and the name must be typed back as confirmation.
  server.delete("/v1/projects/:projectId", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    const project = await dependencies.projects.get(projectId);
    if (!project || !(await dependencies.authorize.canAccess(principal, projectId, "viewer"))) return sendError(reply, 404, "not_found", "Project not found");
    if (project.ownerId !== principal.userId) return sendError(reply, 403, "forbidden", "Only the project's owner can delete it");
    const confirmName = asRecord(request.body).confirmName;
    if (typeof confirmName !== "string" || confirmName.trim().toLowerCase() !== project.name.trim().toLowerCase()) return sendError(reply, 400, "confirmation_required", "Type the project's name to confirm deleting it");
    if (!dependencies.projects.delete) return sendError(reply, 501, "not_supported", "Deleting projects is not available");
    // Stored media first (uploads, proxies, renders, generated music); the database rows go last so nothing is orphaned unseen.
    let removedObjects = 0;
    if (dependencies.storage) {
      const keys = new Set<string>();
      for (const asset of await dependencies.assets.listForProject(projectId)) {
        keys.add(asset.storageKey);
        if (typeof asset.metadata.proxyKey === "string") keys.add(asset.metadata.proxyKey);
      }
      if (dependencies.storage.list) for (const object of await dependencies.storage.list("projects/" + projectId + "/").catch(() => [])) keys.add(object.key);
      for (const key of keys) {
        if (!key.startsWith("projects/" + projectId + "/")) continue; // never touch anything outside this project
        try { await dependencies.storage.remove(key); removedObjects += 1; } catch (error) { request.log.warn({ error, key }, "Could not remove a stored object of a deleted project"); }
      }
    }
    await dependencies.assets.deleteForProject?.(projectId);
    await dependencies.projects.delete(projectId);
    request.log.info({ projectId, removedObjects }, "project deleted");
    return reply.code(200).send({ deleted: true, removedObjects });
  });

  server.get("/v1/projects/:projectId", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "viewer"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const project = await dependencies.projects.get(projectId);
    if (!project) return sendError(reply, 404, "not_found", "Project not found");
    return { project };
  });

  server.get("/v1/projects/:projectId/assets", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "viewer"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const project = await dependencies.projects.get(projectId);
    if (!project) return sendError(reply, 404, "not_found", "Project not found");
    return { assets: await dependencies.assets.listForProject(projectId) };
  });

  server.get("/v1/projects/:projectId/members", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.members) return sendError(reply, 503, "members_unavailable", "Project member management is not configured");
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "viewer"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const project = await dependencies.projects.get(projectId);
    if (!project) return sendError(reply, 404, "not_found", "Project not found");
    return { members: await dependencies.members.listForProject(projectId) };
  });

  server.put("/v1/projects/:projectId/members/:userId", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.members) return sendError(reply, 503, "members_unavailable", "Project member management is not configured");
    const params = asRecord(request.params);
    const projectId = params.projectId;
    const userId = params.userId;
    if (typeof projectId !== "string" || typeof userId !== "string" || !userId.trim()) return sendError(reply, 400, "invalid_request", "projectId and userId are required");
    const project = await dependencies.projects.get(projectId);
    if (!project) return sendError(reply, 404, "not_found", "Project not found");
    if (project.ownerId !== principal.userId) return sendError(reply, 403, "forbidden", "Only the project owner can manage members");
    if (userId === project.ownerId) return sendError(reply, 400, "invalid_request", "The project owner is implicit and cannot be added as a member");
    const body = asRecord(request.body);
    if (body.role !== "editor" && body.role !== "viewer") return sendError(reply, 400, "invalid_request", "role must be editor or viewer");
    const member = { projectId, userId, role: body.role, createdAt: clock.now() } as const;
    await dependencies.members.upsert(member);
    return reply.code(200).send({ member });
  });

  server.delete("/v1/projects/:projectId/members/:userId", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.members) return sendError(reply, 503, "members_unavailable", "Project member management is not configured");
    const params = asRecord(request.params);
    const projectId = params.projectId;
    const userId = params.userId;
    if (typeof projectId !== "string" || typeof userId !== "string" || !userId.trim()) return sendError(reply, 400, "invalid_request", "projectId and userId are required");
    const project = await dependencies.projects.get(projectId);
    if (!project) return sendError(reply, 404, "not_found", "Project not found");
    if (project.ownerId !== principal.userId) return sendError(reply, 403, "forbidden", "Only the project owner can manage members");
    await dependencies.members.remove(projectId, userId);
    return reply.code(204).send();
  });

  server.patch("/v1/projects/:projectId", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const body = asRecord(request.body);
    if (typeof body.name !== "string") return sendError(reply, 400, "invalid_request", "name is required");
    try {
      const project = await projectService.renameProject(projectId, body.name);
      return { project };
    } catch (error) {
      if (error instanceof ProjectNameTakenError) return sendError(reply, 409, error.code, error.message);
      return sendError(reply, 400, "invalid_request", messageOf(error));
    }
  });

  server.post("/v1/projects", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const body = asRecord(request.body);
    if (typeof body.name !== "string") return sendError(reply, 400, "invalid_request", "name is required");
    try {
      const project = await projectService.createProject({ ownerId: principal.userId, name: body.name });
      return reply.code(201).send({ project });
    } catch (error) {
      if (error instanceof ProjectNameTakenError) return sendError(reply, 409, error.code, error.message);
      return sendError(reply, 400, "invalid_request", messageOf(error));
    }
  });

  server.post("/v1/projects/:projectId/assets", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const body = asRecord(request.body);
    const kind = body.kind;
    const storageKey = body.storageKey;
    const checksumSha256 = body.checksumSha256;
    if (!isMediaKind(kind) || typeof storageKey !== "string" || typeof checksumSha256 !== "string") {
      return sendError(reply, 400, "invalid_request", "kind, storageKey, and checksumSha256 are required");
    }
    if (!dependencies.storage) return sendError(reply, 503, "storage_unavailable", "Asset storage is not configured");
    try { await stat(dependencies.storage.resolve(storageKey)); }
    catch (error) { return sendError(reply, 400, "invalid_request", messageOf(error)); }
    const asset: Asset = {
      id: ids.next(), projectId, kind, storageKey, checksumSha256,
      ...(typeof body.durationUs === "number" ? { durationUs: body.durationUs } : {}),
      metadata: isMetadata(body.metadata) ? body.metadata : {},
      createdAt: clock.now(),
    };
    try {
      await projectService.addAsset(asset);
      return reply.code(201).send({ asset });
    } catch (error) {
      return sendError(reply, 400, "invalid_request", messageOf(error));
    }
  });

  server.post("/v1/projects/:projectId/assets/:assetId/scenes", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } } as any, async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.sceneDetector) return sendError(reply, 503, "scene_detector_unavailable", "Scene detection service is not configured");
    const params = asRecord(request.params);
    const projectId = params.projectId;
    const assetId = params.assetId;
    if (typeof projectId !== "string" || typeof assetId !== "string") return sendError(reply, 400, "invalid_request", "projectId and assetId are required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const asset = (await dependencies.assets.listForProject(projectId)).find((candidate) => candidate.id === assetId);
    if (!asset) return sendError(reply, 404, "not_found", "Asset not found");
    try {
      const detected = await dependencies.sceneDetector.detect(asset.storageKey);
      if (dependencies.scenes) {
        await dependencies.scenes.replaceForAsset(assetId, detected.map((scene) => ({
          id: scene.id,
          assetId,
          startUs: scene.startUs,
          endUs: scene.endUs,
          createdAt: clock.now(),
        })));
        const scenes = await dependencies.scenes.listForAsset(assetId);
        return reply.code(201).send({ assetId, scenes });
      }
      return reply.code(201).send({ assetId, scenes: detected });
    } catch (error) {
      return sendError(reply, 503, "scene_detector_unavailable", messageOf(error));
    }
  });

  server.get("/v1/projects/:projectId/assets/:assetId/scenes", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.scenes) return sendError(reply, 503, "scene_storage_unavailable", "Scene storage is not configured");
    const params = asRecord(request.params);
    const projectId = params.projectId;
    const assetId = params.assetId;
    if (typeof projectId !== "string" || typeof assetId !== "string") return sendError(reply, 400, "invalid_request", "projectId and assetId are required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "viewer"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const asset = (await dependencies.assets.listForProject(projectId)).find((candidate) => candidate.id === assetId);
    if (!asset) return sendError(reply, 404, "not_found", "Asset not found");
    return { assetId, scenes: await dependencies.scenes.listForAsset(assetId) };
  });

  server.post("/v1/projects/:projectId/assets/:assetId/transcript", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.transcriber || !dependencies.transcripts) return sendError(reply, 503, "transcriber_unavailable", "Transcription service is not configured");
    const params = asRecord(request.params);
    const projectId = params.projectId;
    const assetId = params.assetId;
    if (typeof projectId !== "string" || typeof assetId !== "string") return sendError(reply, 400, "invalid_request", "projectId and assetId are required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const asset = (await dependencies.assets.listForProject(projectId)).find((candidate) => candidate.id === assetId);
    if (!asset) return sendError(reply, 404, "not_found", "Asset not found");

    try {
      const segments = await dependencies.transcriber.transcribe(asset);
      if (segments.some((segment) => segment.assetId !== assetId || segment.endUs <= segment.startUs || segment.startUs < 0)) {
        return sendError(reply, 502, "invalid_provider_response", "Transcription provider returned invalid segments");
      }
      await dependencies.transcripts.replaceForAsset(assetId, segments);
      return reply.code(201).send({ assetId, segments });
    } catch (error) {
      return sendError(reply, 503, "transcriber_unavailable", messageOf(error));
    }
  });

  server.get("/v1/projects/:projectId/assets/:assetId/transcript", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.transcripts) return sendError(reply, 503, "transcriber_unavailable", "Transcript storage is not configured");
    const params = asRecord(request.params);
    const projectId = params.projectId;
    const assetId = params.assetId;
    if (typeof projectId !== "string" || typeof assetId !== "string") return sendError(reply, 400, "invalid_request", "projectId and assetId are required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "viewer"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const asset = (await dependencies.assets.listForProject(projectId)).find((candidate) => candidate.id === assetId);
    if (!asset) return sendError(reply, 404, "not_found", "Asset not found");
    return { assetId, segments: await dependencies.transcripts.listForAsset(assetId) };
  });

  server.post("/v1/projects/:projectId/proposals", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.strategies || !dependencies.transcripts || !dependencies.proposals) return sendError(reply, 503, "strategy_unavailable", "Strategy, transcript, or proposal service is not configured");
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "viewer"))) return sendError(reply, 403, "forbidden", "Project access denied");

    const body = asRecord(request.body);
    if (typeof body.strategyId !== "string" || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1 || !isTailoringProfile(body.profile)) {
      return sendError(reply, 400, "invalid_request", "strategyId, revision, and a valid tailoring profile are required");
    }
    const [project, revision] = await Promise.all([
      dependencies.projects.get(projectId),
      dependencies.revisions.get(projectId, body.revision as number),
    ]);
    if (!project || !revision) return sendError(reply, 404, "not_found", "Project revision not found");

    try {
      const strategy = dependencies.strategies.get(
        body.strategyId,
        typeof body.strategyVersion === "string" ? body.strategyVersion : undefined,
      );
      const assetIds = new Set(revision.timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)));
      const transcriptLists = await Promise.all([...assetIds].map((assetId) => dependencies.transcripts!.listForAsset(assetId)));
      // Audio-level silence is an optional extra signal; word gaps still work when it is unavailable.
      let signals: TimelineSignals | undefined;
      if (dependencies.silenceDetector) {
        const sourceAssetId = revision.timeline.tracks.find((track) => track.kind === "video")?.clips[0]?.assetId;
        const sourceAsset = sourceAssetId ? (await dependencies.assets.listForProject(projectId)).find((candidate) => candidate.id === sourceAssetId) : undefined;
        if (sourceAsset) {
          const silences = await dependencies.silenceDetector.detect(sourceAsset.storageKey).catch((caught) => { requestLog(reply, caught, "Silence detection failed; continuing with word gaps"); return []; });
          const scenes = dependencies.silenceDetector.detectScenes
            ? await dependencies.silenceDetector.detectScenes(sourceAsset.storageKey).catch((caught) => { requestLog(reply, caught, "Scene detection failed; continuing without shot boundaries"); return []; })
            : [];
          signals = { silences, ...(scenes.length > 1 ? { scenes } : {}) };
        }
      }
      const learned = await learnedFor(dependencies.preferences, principal.userId).catch((caught) => { requestLog(reply, caught, "Preference lookup failed; using base weights"); return undefined; });
      const result = await strategy.propose({
        project,
        revision,
        profile: body.profile,
        transcript: transcriptLists.flat(),
        ...(signals ? { signals } : {}),
        ...(learned ? { learned } : {}),
      });
      const proposal: EditingProposal = {
        id: ids.next(),
        projectId,
        baseRevision: revision.revision,
        strategyId: strategy.id,
        strategyVersion: strategy.version,
        ...result,
      };
      validateProposal(proposal);
      await dependencies.proposals.save(proposal);
      return reply.code(200).send({ proposal });
    } catch (error) {
      return sendError(reply, 400, "invalid_request", messageOf(error));
    }
  });

  server.post("/v1/projects/:projectId/proposals/:proposalId/decision", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.proposals) return sendError(reply, 503, "proposal_unavailable", "Proposal storage is not configured");
    const params = asRecord(request.params);
    const projectId = params.projectId;
    const proposalId = params.proposalId;
    if (typeof projectId !== "string" || typeof proposalId !== "string") return sendError(reply, 400, "invalid_request", "projectId and proposalId are required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const proposal = await dependencies.proposals.get(proposalId);
    if (!proposal || proposal.projectId !== projectId) return sendError(reply, 404, "not_found", "Proposal not found");
    if (proposal.status !== "proposed") return sendError(reply, 409, "proposal_state", "Proposal is no longer pending");

    const body = asRecord(request.body);
    if (body.decision !== "accepted" && body.decision !== "rejected") return sendError(reply, 400, "invalid_request", "decision must be accepted or rejected");
    if (body.decision === "rejected") {
      await dependencies.proposals.setStatus(proposal.id, "rejected");
      await record(dependencies.preferences, rejectedSamples(principal.userId, proposal, clock.now()), (caught) => requestLog(reply, caught, "Could not record preference samples"));
      return { proposal: { ...proposal, status: "rejected" } };
    }

    const base = await dependencies.revisions.get(projectId, proposal.baseRevision);
    if (!base) return sendError(reply, 409, "revision_conflict", "Proposal base revision is no longer available");
    try {
      const revision = await projectService.saveRevision({
        projectId,
        createdBy: principal.userId,
        timeline: applyTimelineOperations(base.timeline, proposal.operations),
        ...(base.tailoring === undefined ? {} : { tailoring: base.tailoring }),
        acceptedProposalIds: [...base.acceptedProposalIds, proposal.id],
      });
      await dependencies.proposals.setStatus(proposal.id, "accepted");
      return reply.code(201).send({ proposal: { ...proposal, status: "accepted" }, revision });
    } catch (error) {
      return sendError(reply, 400, "invalid_proposal", messageOf(error));
    }
  });

  server.post("/v1/projects/:projectId/revisions", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const body = asRecord(request.body);
    if (!isTimeline(body.timeline)) return sendError(reply, 400, "invalid_request", "timeline is required");
    try {
      const revision = await projectService.saveRevision({
        projectId, createdBy: principal.userId, timeline: body.timeline,
        ...(isJsonObject(body.tailoring) ? { tailoring: body.tailoring as unknown as NonNullable<ProjectRevision["tailoring"]> } : {}),
        acceptedProposalIds: Array.isArray(body.acceptedProposalIds) ? body.acceptedProposalIds.filter((value): value is string => typeof value === "string") : [],
      });
      return reply.code(201).send({ revision });
    } catch (error) {
      return sendError(reply, 400, "invalid_request", messageOf(error));
    }
  });

  server.get("/v1/projects/:projectId/revisions/:revision", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const params = asRecord(request.params);
    const projectId = params.projectId;
    const revisionValue = params.revision;
    if (typeof projectId !== "string" || typeof revisionValue !== "string" || !/^\d+$/.test(revisionValue)) {
      return sendError(reply, 400, "invalid_request", "projectId and a positive revision are required");
    }
    const revisionNumber = Number(revisionValue);
    if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) return sendError(reply, 400, "invalid_request", "revision must be a positive integer");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "viewer"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const revision = await dependencies.revisions.get(projectId, revisionNumber);
    if (!revision) return sendError(reply, 404, "not_found", "Project revision not found");
    return { revision };
  });

  server.post("/v1/projects/:projectId/renders", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    if (!dependencies.renderer) return sendError(reply, 503, "renderer_unavailable", "Render service is not configured");
    const { projectId } = asRecord(request.params);
    if (typeof projectId !== "string") return sendError(reply, 400, "invalid_request", "projectId is required");
    if (!(await dependencies.authorize.canAccess(principal, projectId, "editor"))) return sendError(reply, 403, "forbidden", "Project access denied");
    const body = asRecord(request.body);
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) return sendError(reply, 400, "invalid_request", "revision must be a positive integer");
    if (!isRenderSettings(body.settings) || typeof body.idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{8,200}$/.test(body.idempotencyKey)) {
      return sendError(reply, 400, "invalid_request", "settings and a valid idempotencyKey are required");
    }
    const [project, revision] = await Promise.all([dependencies.projects.get(projectId), dependencies.revisions.get(projectId, body.revision as number)]);
    if (!project || !revision) return sendError(reply, 404, "not_found", "Project revision not found");
    try {
      const job = await dependencies.renderer.enqueue({ project, revision, settings: body.settings, idempotencyKey: body.idempotencyKey });
      // Exporting is the strongest sign the chosen clips were right.
      await record(dependencies.preferences, exportedSamples(principal.userId, projectId, revision.revision, revision.timeline, clock.now()), (caught) => requestLog(reply, caught, "Could not record preference samples"));
      return reply.code(202).send({ job });
    } catch (error) {
      return sendError(reply, 503, "render_unavailable", messageOf(error));
    }
  });

  return server;
}
async function authenticate(authenticator: Authenticator, request: FastifyRequest, reply: FastifyReply): Promise<Principal | null> {
  const principal = await authenticator.authenticate(request);
  if (!principal) { sendError(reply, 401, "unauthorized", "Authentication required"); return null; }
  (request as FastifyRequest & { videocraftPrincipal?: Principal }).videocraftPrincipal = principal;
  return principal;
}
function hasBearerToken(request: FastifyRequest, expected: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}
function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) { return reply.code(statusCode).send({ error: { code, message } }); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Request failed"; }
function requestLog(reply: FastifyReply, error: unknown, message: string): void {
  reply.log.error({ error }, message);
}

function asRecord(value: unknown): Record<string, unknown> { return isJsonObject(value) ? value : {}; }
function isJsonObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMetadata(value: unknown): value is Record<string, string | number | boolean> {
  return isJsonObject(value) && Object.values(value).every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean");
}
function isMediaKind(value: unknown): value is Asset["kind"] { return value === "video" || value === "audio" || value === "image" || value === "caption"; }
function isTimeline(value: unknown): value is Timeline {
  if (!isJsonObject(value) || typeof value.durationUs !== "number" || !Array.isArray(value.tracks)) return false;
  return value.tracks.every((track) => isJsonObject(track) && typeof track.id === "string" && typeof track.kind === "string" && Array.isArray(track.clips));
}
function isTailoringProfile(value: unknown): value is TailoringProfile {
  if (!isJsonObject(value) || typeof value.intent !== "string" || typeof value.audience !== "string" || typeof value.channel !== "string" || !Array.isArray(value.constraints)) return false;
  if (!value.constraints.every((entry) => typeof entry === "string")) return false;
  if (value.targetDurationUs !== undefined && typeof value.targetDurationUs !== "number") return false;
  if (value.tone !== undefined && typeof value.tone !== "string") return false;
  return true;
}
function isRenderSettings(value: unknown): value is RenderSettings {
  if (!isJsonObject(value)) return false;
  const formats = value.format === "mp4" || value.format === "webm";
  const codecs = (value.videoCodec === "libx264" || value.videoCodec === "libvpx-vp9") && (value.audioCodec === "aac" || value.audioCodec === "libopus");
  const fit = value.fit === undefined || value.fit === "contain" || value.fit === "cover";
  const captionStyle = value.captionStyle === undefined || (typeof value.captionStyle === "string" && /^[a-z0-9-]{1,40}$/.test(value.captionStyle));
  const loudness = (value.normalizeLoudness === undefined || typeof value.normalizeLoudness === "boolean") && (value.loudnessLufs === undefined || (typeof value.loudnessLufs === "number" && value.loudnessLufs >= -30 && value.loudnessLufs <= -5));
  return formats && codecs && fit && captionStyle && loudness && Number.isInteger(value.width) && Number.isInteger(value.height) && Number.isInteger(value.frameRate) && (value.width as number) >= 2 && (value.height as number) >= 2 && (value.frameRate as number) > 0 && (value.frameRate as number) <= 120;
}
