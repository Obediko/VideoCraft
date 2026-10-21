import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { validateProposal } from "@videocraft/domain";
import type { Asset, EditingProposal, ProjectRevision, RenderSettings, RendererPort, StrategyRegistry, TailoringProfile, Timeline, TimelineClip, TimelineOperation, TranscriptSegment, TranscriptionPort, UUID } from "@videocraft/domain";
import { ProjectService, type Clock, type IdFactory, type ProjectRepository, type AssetRepository, type RevisionRepository } from "@videocraft/application";
import type { ObjectStorage } from "@videocraft/storage";

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
export interface AuditWriter {
  append(event: { id: string; actorId?: string; projectId?: string; action: string; method: string; route: string; statusCode: number; requestId: string; metadata?: Record<string, string | number | boolean>; createdAt: string }): Promise<void>;
}
export interface ApiDependencies {
  projects: ProjectRepository; assets: AssetRepository; revisions: RevisionRepository; storage?: ObjectStorage;
  authenticate: Authenticator; authorize: ProjectAuthorizer;
  renderer?: RendererPort; transcriber?: TranscriptionPort; transcripts?: TranscriptStore; strategies?: StrategyRegistry; proposals?: ProposalStore;
  clock?: Clock; ids?: IdFactory; audit?: AuditWriter;
}

export function buildServer(dependencies: ApiDependencies): FastifyInstance {
  const server = Fastify({ logger: true, bodyLimit: 1_000_000 });
  const clock = dependencies.clock ?? { now: () => new Date().toISOString() };
  const ids = dependencies.ids ?? { next: () => randomUUID() };
  const projectService = new ProjectService(dependencies.projects, dependencies.assets, dependencies.revisions, ids, clock);

  server.addHook("onResponse", async (request, reply) => {
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

  server.post("/v1/projects", async (request, reply) => {
    const principal = await authenticate(dependencies.authenticate, request, reply);
    if (!principal) return;
    const body = asRecord(request.body);
    if (typeof body.name !== "string") return sendError(reply, 400, "invalid_request", "name is required");
    try {
      const project = await projectService.createProject({ ownerId: principal.userId, name: body.name });
      return reply.code(201).send({ project });
    } catch (error) {
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
      const result = await strategy.propose({
        project,
        revision,
        profile: body.profile,
        transcript: transcriptLists.flat(),
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
function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) { return reply.code(statusCode).send({ error: { code, message } }); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Request failed"; }
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
function applyTimelineOperations(timeline: Timeline, operations: TimelineOperation[]): Timeline {
  const tracks = timeline.tracks.map((track) => ({ ...track, clips: [...track.clips] }));
  for (const operation of operations) {
    if (operation.type === "add-caption") {
      const captionTrack = tracks.find((track) => track.kind === "caption");
      const clip: TimelineClip = {
        id: "caption-" + operation.atUs + "-" + operation.durationUs,
        assetId: "generated:caption",
        sourceStartUs: 0,
        sourceEndUs: operation.durationUs,
        timelineStartUs: operation.atUs,
        timelineEndUs: operation.atUs + operation.durationUs,
        transform: { text: operation.text },
      };
      if (captionTrack) captionTrack.clips.push(clip);
      else tracks.push({ id: "captions", kind: "caption", clips: [clip] });
      continue;
    }
    let found = false;
    for (const track of tracks) {
      const index = track.clips.findIndex((clip) => clip.id === operation.clipId);
      if (index < 0) continue;
      found = true;
      const clip = track.clips[index];
      if (!clip) continue;
      if (operation.type === "remove-clip") track.clips.splice(index, 1);
      if (operation.type === "trim-clip") {
        if (operation.sourceEndUs <= operation.sourceStartUs) throw new Error("Trim range is invalid");
        track.clips[index] = {
          ...clip,
          sourceStartUs: operation.sourceStartUs,
          sourceEndUs: operation.sourceEndUs,
          timelineEndUs: clip.timelineStartUs + operation.sourceEndUs - operation.sourceStartUs,
        };
      }
      if (operation.type === "split-clip") {
        if (operation.atUs <= clip.sourceStartUs || operation.atUs >= clip.sourceEndUs) throw new Error("Split point is invalid");
        const sourceRatio = (operation.atUs - clip.sourceStartUs) / (clip.sourceEndUs - clip.sourceStartUs);
        const timelineAt = clip.timelineStartUs + Math.round((clip.timelineEndUs - clip.timelineStartUs) * sourceRatio);
        const first: TimelineClip = { ...clip, id: clip.id + ":a", sourceEndUs: operation.atUs, timelineEndUs: timelineAt };
        const second: TimelineClip = { ...clip, id: clip.id + ":b", sourceStartUs: operation.atUs, timelineStartUs: timelineAt };
        track.clips.splice(index, 1, first, second);
      }
      break;
    }
    if (!found) throw new Error("Proposal references an unknown clip");
  }
  return { ...timeline, tracks };
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
  return formats && codecs && Number.isInteger(value.width) && Number.isInteger(value.height) && Number.isInteger(value.frameRate) && (value.width as number) >= 2 && (value.height as number) >= 2 && (value.frameRate as number) > 0 && (value.frameRate as number) <= 120;
}
