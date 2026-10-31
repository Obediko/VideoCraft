import type { FastifyInstance } from "fastify";
import { parseEffectRecipe, type EffectRecipe, type TimelineClip } from "@videocraft/domain";
import { sanitizePlan, type DirectorInput, type DirectorPlan, type StockPick } from "@videocraft/director";
import type { DirectorRouteDependencies } from "./director-routes.js";
import { sampleStoryFrames } from "./creation.js";

/** Suggest reversible creative treatments in edited time, without recutting a mixed-media story. */
export function registerCreativeRoutes(server: FastifyInstance, deps: DirectorRouteDependencies): void {
  server.post<{ Params: { projectId: string }; Body: { revision?: number; brief?: string } }>("/v1/projects/:projectId/creative/plan", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (request, reply) => {
    const user = await deps.authenticate(request);
    if (!user) return reply.code(401).send({ error: { message: "Sign in to plan creative treatments" } });
    const { projectId } = request.params;
    if (!await deps.authorize.canAccess(user, projectId, "editor")) return reply.code(403).send({ error: { message: "Project access denied" } });
    const body = request.body ?? {};
    if (!Number.isSafeInteger(body.revision) || body.revision! < 1) return reply.code(400).send({ error: { message: "Choose a saved revision" } });
    const project = await deps.projects.get(projectId), revision = await deps.revisions.get(projectId, body.revision!);
    if (!project || !revision) return reply.code(404).send({ error: { message: "Revision not found" } });
    if (project.revision !== revision.revision) return reply.code(409).send({ error: { message: "A newer edit exists. Reload before planning treatments." } });
    const timeline = revision.timeline;
    const clips = timeline.tracks.filter(t => t.kind === "video").flatMap(t => t.clips).sort((a,b) => a.timelineStartUs - b.timelineStartUs);
    if (!clips.length || timeline.durationUs <= 0) return reply.code(422).send({ error: { message: "Assemble your story first" } });
    if (clips.length > 40 || timeline.durationUs > 600_000_000) return reply.code(422).send({ error: { message: "Creative planning supports up to 40 pieces and ten minutes" } });
    const assets = await deps.assets.listForProject(projectId), used = new Set(clips.map(c => c.assetId));
    const sampled = clips.length > 8 ? [...clips.slice(0,7),clips[clips.length-1]!] : clips;
    const moments = sampled.map(c => ({ assetId: c.assetId, atS: (c.sourceStartUs + Math.min(800_000,(c.sourceEndUs-c.sourceStartUs)/2)) / 1e6 }));
    const visualAssets = assets.filter(a => used.has(a.id) && (a.kind === "image" || a.kind === "video"));
    const shots = await sampleStoryFrames(deps, visualAssets, moments);
    const frames = shots.flatMap(f => {
      const host = sampled.find(c => c.assetId === f.assetId && (assets.find(a=>a.id===c.assetId)?.kind === "image" || (f.atS*1e6 >= c.sourceStartUs && f.atS*1e6 < c.sourceEndUs)));
      return host ? [{ atS: (host.timelineStartUs + (assets.find(a=>a.id===host.assetId)?.kind === "image" ? 0 : f.atS*1e6-host.sourceStartUs)) / 1e6, jpegBase64: f.jpegBase64 }] : [];
    });
    const voiceovers = timeline.tracks.filter(t=>t.kind==="audio").flatMap(t=>t.clips).filter(c=>c.transform?.role==="voiceover");
    const audible: TimelineClip[] = [...clips.filter(c=>c.transform?.muteSource !== true && assets.find(a=>a.id===c.assetId)?.kind==="video"), ...voiceovers];
    const transcripts = new Map(await Promise.all([...new Set(audible.map(c=>c.assetId))].slice(0,40).map(async id => [id, await deps.transcripts.listForAsset(id)] as const)));
    const transcript: DirectorInput["transcript"] = audible.flatMap(c => (transcripts.get(c.assetId) ?? []).flatMap(s => {
      const words = s.words.filter(w=>w.startUs>=c.sourceStartUs && w.endUs<=c.sourceEndUs);
      const text = words.length ? words.map(w=>w.text).join(" ") : s.startUs>=c.sourceStartUs && s.endUs<=c.sourceEndUs ? s.text : "";
      if (!text) return [];
      return [{ startS: (c.timelineStartUs + Math.max(words[0]?.startUs ?? s.startUs,c.sourceStartUs)-c.sourceStartUs)/1e6, endS: (c.timelineStartUs + Math.min(words[words.length-1]?.endUs ?? s.endUs,c.sourceEndUs)-c.sourceStartUs)/1e6, text }];
    })).sort((a,b)=>a.startS-b.startS);
    if (!transcript.length) for (const c of timeline.tracks.filter(t=>t.kind==="caption").flatMap(t=>t.clips)) if (c.transform?.text) transcript.push({ startS:c.timelineStartUs/1e6,endS:c.timelineEndUs/1e6,text:String(c.transform.text) });
    const graphics = timeline.tracks.filter(t=>t.kind==="overlay").flatMap(t=>t.clips);
    const brief = (typeof body.brief === "string" ? body.brief.trim().slice(0,600) : "");
    const input: DirectorInput = {
      brief: "CREATIVE TREATMENTS ONLY. All times are EDITED TIMELINE seconds, not original-source seconds. Preserve the story order, narration and music. Propose only effect or stock suggestions where they add meaning, never cuts. Creator's goal: " + (revision.tailoring?.intent ?? "").slice(0,600) + ". Treatment direction: " + (brief || "Tasteful, varied, restrained, relevant to each moment.") + ". Existing overlays: " + graphics.slice(0,8).map(c=>String(c.transform?.text ?? c.transform?.role)+" at "+c.timelineStartUs/1e6).join("; ") + ". Visual evidence: " + frames.length + " sampled source frames, not a complete visual review.",
      durationS: timeline.durationUs/1e6, frame: revision.tailoring?.channel === "youtube" ? {width:1920,height:1080} : {width:1080,height:1920}, transcript,
      candidates: clips.map((c,i)=>({ id:"piece-"+i,startS:c.timelineStartUs/1e6,endS:c.timelineEndUs/1e6,text:String(assets.find(a=>a.id===c.assetId)?.metadata.filename ?? "Visual")+". "+transcript.filter(s=>s.startS<c.timelineEndUs/1e6&&s.endS>c.timelineStartUs/1e6).map(s=>s.text).join(" ").slice(0,300),score:0.5 })), frames,
      assets: visualAssets.map(a=>({id:a.id,kind:a.kind as "video"|"image",name:String(a.metadata.filename??a.kind).slice(0,80)})),
      ...(deps.effects ? { effects:(await deps.effects.list(user.userId).catch(()=>[])).slice(0,24).map(e=>e.recipe) } : {}),
    };
    let generated: DirectorPlan;
    try { generated = await deps.director.plan(input); }
    catch (caught) { request.log.warn({err:caught}, "Creative planning failed"); return reply.code(502).send({error:{message:"Creative planning is unavailable. Try again or choose a built-in treatment."}}); }
    const plan = sanitizePlan(generated,input,generated.source,generated.model ? {model:generated.model} : {});
    const proposals: Array<{id:string;title:string;reason:string;atUs:number;recipe:EffectRecipe;stockPreview?:StockPick}> = [];
    for (const s of plan.suggestions) {
      if (!s.reason.trim() || generated.source !== "ai" || (s.kind !== "effect" && s.kind !== "stock")) continue;
      const atUs = Math.round(s.atS*1e6), host = clips.find(c=>atUs>=c.timelineStartUs&&atUs<c.timelineEndUs);
      if (!host || host.timelineEndUs-atUs<1_000_000 || proposals.length>=3 || proposals.some(p=>Math.abs(p.atUs-atUs)<4e6)) continue;
      let recipe: EffectRecipe; let stockPreview: StockPick | undefined;
      if (s.kind === "stock") {
        const pick = s.pick ?? await deps.previewStock?.(s.query,s.assetKind,revision.tailoring?.channel==="youtube"?"landscape":"portrait").catch(()=>undefined);
        if (!pick || !["pexels","pixabay"].includes(pick.provider) || !/^[0-9]{1,20}$/.test(pick.id) || s.assetKind === "gif") continue;
        stockPreview = pick;
        recipe = parseEffectRecipe({presetId:"stock-cutaway",text:s.query,durationS:Math.max(1,Math.min(6,s.durationS)),stock:{provider:pick.provider,id:pick.id,kind:s.assetKind,mode:s.mode}});
      } else recipe = s.recipe;
      const durationS = Math.min(recipe.durationS,Math.floor((host.timelineEndUs-atUs)/10_000)/100);
      const isGraphic = !recipe.stock && !["focus","impact","smooth-reveal"].includes(recipe.presetId);
      if (graphics.some(c=>c.timelineStartUs<atUs+durationS*1e6&&c.timelineEndUs>atUs&&((recipe.stock&&c.transform?.role==="broll")||(isGraphic&&c.transform?.role==="graphic")))) continue;
      proposals.push({id:s.id,title:s.title,reason:s.reason,atUs,recipe:{...recipe,durationS},...(stockPreview ? {stockPreview} : {})});
    }
    return {revision:revision.revision,source:generated.source,proposals,sampledFrames:frames.length,note:generated.source!=="ai" ? "Creative suggestions need the AI provider. Built-in treatments remain available." : frames.length ? "Planned from the script, timeline and sampled source frames. Preview each treatment before export." : "Planned from the script and timeline; no usable source frames were available. Preview each treatment before export."};
  });
}
