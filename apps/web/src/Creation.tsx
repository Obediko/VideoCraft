import { useEffect, useState } from "react";
import { StockSearch } from "./StockSearch.js";
import { VoiceOver } from "./VoiceOver.js";

export type CreationMode = "footage" | "story" | "idea";
type Asset = { id: string; kind: string; durationUs?: number; metadata: Record<string, string | number | boolean> };
type Scene = { assetId: string; startS: number; durationS: number; text: string; visual: string; search?: string; thumb?: string; transition?: string; transitionSeconds?: number; look?: string; zoom?: string };
type StockItem = { provider: string; id: string; kind: "video" | "photo" | "gif"; thumbUrl: string; durationS?: number; credit?: string };
const CAMERA = new Set("a an the and or of to in on at with into onto over under from by for as is are be then while their his her its our your this that these those same shot close-up closeup close up wide medium tracking lateral smooth slow push pull pan tilt zoom frame framing angle eye level depth field shallow cut match-cut match cinematic camera lens focus light lighting daylight sunlight warm soft natural gentle gently vignette opening scene continue continues end ends hold brief briefly authentic realistic modest beautiful quiet sunlit morning residential shaded filled moving background pausing pauses beside near through school-age".split(" "));
const TRANSITIONS: Record<string, string> = { cut: "Cut", dissolve: "Dissolve", push: "Push", "slide-up": "Slide up", wipe: "Wipe", circle: "Circle reveal", blur: "Blur", "dip-black": "Dip to black", "dip-white": "Dip to white", flash: "Flash" };
const LOOKS: Record<string, string> = { none: "Natural", warm: "Warm", clean: "Clean & crisp", cinematic: "Cinematic", vivid: "Vivid", soft: "Soft", mono: "Black & white" };
const ZOOMS: Record<string, string> = { none: "Static", push: "Slow push-in", punch: "Punch-in" };
/** Plain search words for a scene (the storyboard gives them; older drafts are worked out from the description). */
const searchOf = (s: Scene) => s.search?.trim() || s.visual.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).map((w) => w.replace(/'s$/, "")).filter((w) => w.length > 2 && !CAMERA.has(w) && !/ly$/.test(w)).filter((w, i, all) => all.indexOf(w) === i).slice(0, 5).join(" ");
type Plan = { summary: string; script: string; scenes: Scene[]; source: "ai" | "rules"; note?: string; selectedApproach?: string; critique?: string };
type Preferences = { notes: string; preferredSentenceWords?: number; avoidPhrases: string[] };
type NarrationMode = "ai" | "existing" | "none";
type Draft = { narrationMode: NarrationMode; voice: string; voiceStyle: string; narrationFingerprint: string; brief: string; seconds: number; platform: string; selected: string[]; plan: Plan | null; narrationId: string; music: boolean; sceneText: boolean; captions: boolean };
type Props = {
  projectId: string; revision: number; mode: CreationMode; assets: Asset[]; apiBase: string; token: string;
  request(path: string, init?: RequestInit): Promise<any>;
  onAsset(asset: Asset): void;
  onReady(result: any): void;
  onWorking(working: boolean): void;
};
const nameOf = (a: Asset) => a.kind === "image" && typeof a.metadata.prompt === "string" ? "Generated · " + a.metadata.prompt.slice(0, 60) : String(a.metadata.filename ?? a.kind);
const message = (e: unknown) => e instanceof Error ? e.message : "The action failed. Your draft is kept; try again.";
const keyOf = (id: string) => "videocraft.story.v1." + id;
const preferenceKey = "videocraft.director.preferences.v1";
function readPreferences(): Preferences {
  try { const p = JSON.parse(localStorage.getItem(preferenceKey) ?? "null"); return { notes: typeof p?.notes === "string" ? p.notes.slice(0, 600) : "", preferredSentenceWords: Number.isFinite(p?.preferredSentenceWords) ? p.preferredSentenceWords : undefined, avoidPhrases: Array.isArray(p?.avoidPhrases) ? p.avoidPhrases.filter((x: unknown) => typeof x === "string").slice(0, 20) : [] }; }
  catch { return { notes: "", avoidPhrases: [] }; }
}
function sentenceWords(script: string): number | undefined { const rows = script.split(/[.!?]+/).map(s => s.trim().split(/\s+/).filter(Boolean).length).filter(Boolean); return rows.length ? Math.max(4, Math.min(30, Math.round(rows.reduce((a, b) => a + b, 0) / rows.length))) : undefined; }
function readDraft(id: string, mode: CreationMode): Draft {
  const empty: Draft = { narrationMode: mode === "idea" ? "ai" : "none", voice: "marin", voiceStyle: "", narrationFingerprint: "", brief: "", seconds: 30, platform: "tiktok", selected: [], plan: null, narrationId: "", music: true, sceneText: true, captions: true };
  try {
    const saved = JSON.parse(localStorage.getItem(keyOf(id)) ?? "null");
    if (!saved || typeof saved.brief !== "string" || !Array.isArray(saved.selected)) return empty;
    const plan = saved.plan;
    if (plan && (typeof plan.summary !== "string" || typeof plan.script !== "string" || !["ai", "rules"].includes(plan.source) || !Array.isArray(plan.scenes) || plan.scenes.length > 40 || !plan.scenes.every((s: Scene) => s && typeof s.assetId === "string" && typeof s.text === "string" && typeof s.visual === "string" && Number.isFinite(s.startS) && Number.isFinite(s.durationS)))) return empty;
    return { narrationMode: ["ai", "existing", "none"].includes(saved.narrationMode) ? saved.narrationMode : saved.narrationId ? "existing" : empty.narrationMode, voice: typeof saved.voice === "string" ? saved.voice : "marin", voiceStyle: typeof saved.voiceStyle === "string" ? saved.voiceStyle.slice(0, 200) : "", narrationFingerprint: typeof saved.narrationFingerprint === "string" ? saved.narrationFingerprint : "", brief: saved.brief.slice(0, 2000), seconds: Number.isFinite(saved.seconds) ? saved.seconds : 30, platform: ["tiktok", "youtube", "square"].includes(saved.platform) ? saved.platform : "tiktok", selected: saved.selected.filter((s: unknown) => typeof s === "string").slice(0, 40), plan: plan ?? null, narrationId: typeof saved.narrationId === "string" ? saved.narrationId : "", music: saved.music !== false, sceneText: saved.sceneText !== false, captions: saved.captions !== false };
  } catch { return empty; }
}

/** The storyboard is a draft until the creator assembles it. Uploads stay available after a failed step. */
export function Creation({ projectId, revision, mode, assets, apiBase, token, request, onAsset, onReady, onWorking }: Props) {
  const [draft, setDraft] = useState<Draft>(() => readDraft(projectId, mode));
  const [working, setWorking] = useState("");
  const [notice, setNotice] = useState("");
  const [images, setImages] = useState(false);
  const [sceneIndex, setSceneIndex] = useState<number | null>(null);
  const [imagePrompt, setImagePrompt] = useState("");
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [urlRetry, setUrlRetry] = useState(0);
  const [recording, setRecording] = useState(false);
  const [voiceWorking, setVoiceWorking] = useState(false);
  const [stockWorking, setStockWorking] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences());
  const [suggested, setSuggested] = useState<Record<number, StockItem[]>>({});
  const [adding, setAdding] = useState("");
  const busy = Boolean(working || recording || voiceWorking || stockWorking);
  const media = assets.filter(a => a.kind === "image" || a.kind === "video");
  const narration = assets.find(a => a.id === draft.narrationId);
  const patch = (change: Partial<Draft>) => setDraft(d => ({ ...d, ...change }));
  useEffect(() => { try { localStorage.setItem(keyOf(projectId), JSON.stringify(draft)); } catch { /* editing remains available */ } }, [projectId, draft]);
  useEffect(() => { try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* preference memory is optional */ } }, [preferences]);
  useEffect(() => { onWorking(busy); return () => onWorking(false); }, [busy]);
  useEffect(() => {
    let cancelled = false;
    request("/v1/projects/" + projectId + "/creation/capabilities").then(r => { if (!cancelled) setImages(r.images === true); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId]);
  const previewId = sceneIndex !== null ? draft.plan?.scenes[sceneIndex]?.assetId ?? "" : "";
  useEffect(() => {
    if (!previewId && !draft.narrationId) return;
    let cancelled = false;
    setPreviewError(false);
    for (const id of new Set([previewId, draft.narrationId].filter(Boolean))) request("/v1/projects/" + projectId + "/assets/" + id + "/playback-url").then(r => {
      if (!cancelled && r.url) setUrls(u => ({ ...u, [id]: /^https?:\/\//.test(r.url) ? r.url : apiBase + r.url }));
    }).catch(e => { if (!cancelled) setNotice(message(e)); });
    return () => { cancelled = true; };
  }, [projectId, previewId, draft.narrationId, urlRetry]);

  async function run(label: string, task: () => Promise<void>) {
    setWorking(label); setNotice("");
    try { await task(); } catch (e) { setNotice(message(e)); } finally { setWorking(""); }
  }
  function scenePatch(index: number, change: Partial<Scene>) {
    setDraft(d => d.plan ? { ...d, plan: { ...d.plan, scenes: d.plan.scenes.map((s, i) => i === index ? { ...s, ...change } : s) } } : d);
  }
  function selectVisual(asset: Asset) {
    onAsset(asset);
    patch({ selected: [...new Set([...draft.selected, asset.id])] });
    if (sceneIndex !== null && draft.plan) {
      const scene = draft.plan.scenes[sceneIndex];
      scenePatch(sceneIndex, { assetId: asset.id, startS: 0, durationS: Math.min(scene?.durationS ?? 5, asset.kind === "video" ? (asset.durationUs ?? 5e6) / 1e6 : 60) });
    }
  }
  /** Scout a few free stock matches for every unresolved scene, shown under it for creator approval. */
  async function scoutScenes(plan: Plan): Promise<number> {
    const orientation = draft.platform === "youtube" ? "landscape" : draft.platform === "square" ? "square" : "portrait";
    const found: Record<number, StockItem[]> = {};
    // Twelve scenes stays below the route budget even when a video miss needs a photo fallback.
    const queue = plan.scenes.map((sc, i) => ({ sc, i })).filter(({ sc }) => !sc.assetId && Boolean(searchOf(sc))).slice(0, 12);
    const byQuery = new Map<string, Promise<StockItem[]>>();
    const lookup = (q: string) => byQuery.get(q) ?? (() => { const work = (async () => {
      const video = await request("/v1/projects/" + projectId + "/stock/search?kind=video&orientation=" + orientation + "&q=" + encodeURIComponent(q)).catch(() => ({ items: [] }));
      if (video.items?.length) return video.items.slice(0, 4);
      const photo = await request("/v1/projects/" + projectId + "/stock/search?kind=photo&orientation=" + orientation + "&q=" + encodeURIComponent(q)).catch(() => ({ items: [] }));
      return (photo.items ?? []).slice(0, 4);
    })(); byQuery.set(q, work); return work; })();
    // A small worker pool keeps the UI responsive without tripping the API's stock-search budget.
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length) {
      const next = queue.shift(); if (!next) break;
      const items = await lookup(searchOf(next.sc));
      if (items.length) found[next.i] = items;
      setSuggested(cur => ({ ...cur, ...(items.length ? { [next.i]: items } : {}) }));
    } }));
    return Object.keys(found).length;
  }
  async function suggestAll() {
    if (!draft.plan) return;
    await run("Finding visuals for every scene…", async () => {
      const found = await scoutScenes(draft.plan!);
      setNotice(found ? "The Visual Director found choices. Pick one under each open scene." : "No stock matched these scenes. Open a scene's search to try other words, or upload your own.");
    });
  }
  async function useSuggestion(index: number, item: StockItem) {
    setAdding(index + ":" + item.id); setNotice("");
    try {
      const r = await request("/v1/projects/" + projectId + "/stock/import", { method: "POST", body: JSON.stringify({ provider: item.provider, kind: item.kind, id: item.id }) });
      const asset = r.asset as Asset; onAsset(asset);
      setDraft((d) => ({ ...d, selected: [...new Set([...d.selected, asset.id])], plan: d.plan ? { ...d.plan, scenes: d.plan.scenes.map((s, i) => i === index ? { ...s, assetId: asset.id, thumb: item.thumbUrl, startS: 0, durationS: Math.min(s.durationS, asset.kind === "video" ? (asset.durationUs ?? 5e6) / 1e6 : 60) } : s) } : d.plan }));
    } catch (e) { setNotice(message(e)); } finally { setAdding(""); }
  }
  async function upload(input: HTMLInputElement, audio = false) {
    const files = Array.from(input.files ?? []); input.value = "";
    if (!files.length) return;
    await run("Uploading media…", async () => {
      const added: Asset[] = []; const failed: string[] = [];
      // Sequential uploads avoid exhausting the scanner and make partial failure recoverable.
      for (const file of files) {
        try {
          const kind = audio ? "audio" : file.type.startsWith("image/") ? "image" : "video";
          const form = new FormData(); form.append("file", file);
          const r = await request("/v1/projects/" + projectId + "/assets/upload?kind=" + kind, { method: "POST", body: form });
          onAsset(r.asset); added.push(r.asset);
        } catch (e) { failed.push(file.name + ": " + message(e)); }
      }
      if (audio && added[0]) patch({ narrationId: added[0].id, narrationMode: "existing", narrationFingerprint: "" });
      else {
        patch({ selected: [...new Set([...draft.selected, ...added.map(a => a.id)])] });
        if (added[0] && sceneIndex !== null) scenePatch(sceneIndex, { assetId: added[0].id, startS: 0, durationS: Math.min(draft.plan?.scenes[sceneIndex]?.durationS ?? 5, added[0].kind === "video" ? (added[0].durationUs ?? 5e6) / 1e6 : 60) });
      }
      setNotice(added.length + " uploaded." + (failed.length ? " Some files need retrying: " + failed.join("; ") : ""));
    });
  }
  async function plan() {
    await run("Making the storyboard…", async () => {
      const result = await request("/v1/projects/" + projectId + "/creation/plan", { method: "POST", body: JSON.stringify({ brief: draft.brief, seconds: draft.seconds, assetIds: draft.selected.filter(id => media.some(a => a.id === id)), preferences }) });
      patch({ plan: result.plan }); setSceneIndex(null); setSuggested({});
      if (result.plan.scenes.some((scene: Scene) => !scene.assetId)) {
        setWorking("The Visual Director is scouting choices…");
        const found = await scoutScenes(result.plan);
        setNotice(found ? "The Visual Director found choices for " + found + " scene" + (found === 1 ? "." : "s.") : "The storyboard is ready, but no free stock matched its open scenes. Try simpler search words or upload a visual.");
      }
    });
  }
  async function assemble() {
    await run("Assembling your edit…", async () => {
      let narrationId = draft.narrationMode === "none" ? "" : draft.narrationId;
      if (draft.narrationMode === "ai") {
        const script = draft.plan?.script.trim() ?? "";
        if (!script) throw new Error("Write or generate a narration script before assembling with an AI voice.");
        const fingerprint = JSON.stringify([script, draft.voice, draft.voiceStyle.trim()]);
        if (!narrationId || !assets.some(a => a.id === narrationId) || draft.narrationFingerprint !== fingerprint) {
          setWorking("Generating AI narration…");
          const result = await request("/v1/projects/" + projectId + "/voiceover/speech", { method: "POST", body: JSON.stringify({ text: script, voice: draft.voice, ...(draft.voiceStyle.trim() ? { style: draft.voiceStyle.trim() } : {}) }) });
          narrationId = result.asset.id; onAsset(result.asset);
          patch({ narrationId, narrationFingerprint: fingerprint });
        }
      } else if (draft.narrationMode === "existing" && !narrationId) throw new Error("Record, upload, or select your narration first.");
      if (narrationId && draft.captions) { setWorking("Transcribing narration…"); await request("/v1/projects/" + projectId + "/assets/" + narrationId + "/transcript", { method: "POST" }); }
      setWorking("Assembling your edit…");
      const result = await request("/v1/projects/" + projectId + "/creation/apply", { method: "POST", body: JSON.stringify({ revision, scenes: draft.plan?.scenes, narrationAssetId: narrationId, music: draft.music, sceneText: draft.sceneText, captions: draft.captions, brief: draft.brief, platform: draft.platform }) });
      onReady(result);
    });
  }
  const scene = sceneIndex !== null ? draft.plan?.scenes[sceneIndex] : undefined;
  const previewAsset = media.find(a => a.id === scene?.assetId);
  const openScenes = draft.plan?.scenes.filter(s => !s.assetId).length ?? 0;
  const ready = Boolean(draft.plan?.scenes.length && openScenes === 0 && (draft.narrationMode === "none" || draft.plan.script.trim() || draft.narrationId));
  return <main className="page creation stack">
    <header className="creation-intro"><span className="eyebrow">VideoCraft Director</span><h1>{mode === "idea" ? "Turn your idea into a story" : "Shape your media into a story"}</h1><p>Tell us what you mean. Your Director develops the structure, scouts fitting visuals, and gives you every important choice.</p><div className="director-team" aria-label="Director team"><span>Story</span><span>Visuals</span><span>Sound</span><span>Critic</span></div></header>
    <section className="card stack" aria-label="Story brief">
      <span className="eyebrow">Direction</span><h2>What should this video leave with people?</h2>
      <label className="brief-field"><span className="sr-only">Your brief</span><textarea rows={4} maxLength={2000} value={draft.brief} disabled={busy} onChange={e => patch({ brief: e.target.value })} placeholder="The message, who it is for, and what they should feel or do afterwards…" /></label>
      <details className="quiet-details"><summary>Set the tone <span className="muted">optional</span></summary><label>How should the Director approach your work?<textarea rows={2} maxLength={600} value={preferences.notes} disabled={busy} onChange={e => setPreferences(p => ({ ...p, notes: e.target.value }))} placeholder="Understated. Nigerian English. No hype. End with a practical invitation." /></label></details>
      <label>Narration preference<select aria-label="Narration preference" value={draft.narrationMode} disabled={busy} onChange={e => patch({ narrationMode: e.target.value as NarrationMode })}><option value="ai">AI-generated narration</option><option value="existing">Record or upload my narration</option><option value="none">Keep original sound / no narration</option></select></label>
      {draft.narrationMode === "ai" && <p className="muted small">AI drafts the narration script with your storyboard. Review the words and voice below; assembling generates and adds the audio automatically.</p>}
      <div className="row-2"><label>Target length (seconds)<input type="number" min={5} max={600} value={draft.seconds} disabled={busy} onChange={e => patch({ seconds: Number(e.target.value) })} /></label>
        <label>Format<select value={draft.platform} disabled={busy} onChange={e => patch({ platform: e.target.value })}><option value="tiktok">Reel / Short · 9:16</option><option value="youtube">YouTube · 16:9</option><option value="square">Feed · 1:1</option></select></label></div>
    </section>
    <section className="card stack" aria-label="Story media">
      <span className="eyebrow">Source material</span><h2>Bring what belongs in the story</h2>
      <p className="muted small">Your own media comes first. When a scene needs something else, the Visual Director will scout choices for you.</p>
      <label className="btn file-btn">Upload videos and photos<input aria-label="Upload videos and photos" type="file" multiple accept="video/*,image/*" disabled={busy} onChange={e => void upload(e.currentTarget)} /></label>
      <div className="creation-library">{media.map(a => <label className="checkbox" key={a.id}><input type="checkbox" disabled={busy} checked={draft.selected.includes(a.id)} onChange={e => patch({ selected: e.target.checked ? [...draft.selected, a.id] : draft.selected.filter(id => id !== a.id) })} />{a.kind === "image" ? "Photo" : "Video"} · {nameOf(a)}</label>)}</div>
      <button className="primary director-action" type="button" disabled={busy || draft.brief.trim().length < 3 || draft.seconds < 5 || draft.seconds > 600} onClick={() => void plan()}>{draft.plan ? "Rethink the direction" : "Develop the first cut"}</button>
      {draft.plan && <p className="muted small">A new storyboard replaces the draft below. Your uploads and narration stay available.</p>}
    </section>
    {draft.plan && <>
      <section className="card stack" aria-label="Storyboard">
        <span className="eyebrow">First cut</span><h2>Review the Director's choices</h2><p className="plan-summary">{draft.plan.summary}</p><p className="muted small">{draft.plan.source === "ai" ? "Directed storyboard" : "Essential storyboard"} · {draft.plan.scenes.reduce((n, s) => n + s.durationS, 0).toFixed(1)} seconds before narration timing</p>
        {draft.plan.note && <p role="status">{draft.plan.note}</p>}{draft.plan.selectedApproach && <p className="muted small">Chosen approach: {draft.plan.selectedApproach}{draft.plan.critique ? " · " + draft.plan.critique : ""}</p>}
        <ol className="creation-scenes">{draft.plan.scenes.map((s, i) => <li key={i} className="stack">
          <strong>Scene {i + 1}: {s.visual || "Choose a visual"}</strong>
          <label>Visual<select aria-label="Visual" value={s.assetId} disabled={busy} onChange={e => { const a = media.find(a => a.id === e.target.value); scenePatch(i, { assetId: e.target.value, startS: 0, durationS: Math.min(s.durationS, a?.kind === "video" ? (a.durationUs ?? 5e6) / 1e6 : 60) }); }}><option value="">Choose a visual</option>{media.map(a => <option key={a.id} value={a.id}>{nameOf(a)}</option>)}</select></label>
          <div className="row-2"><label>Start in source (seconds)<input type="number" min={0} step={0.1} disabled={busy || media.find(a => a.id === s.assetId)?.kind === "image"} value={s.startS} onChange={e => scenePatch(i, { startS: Number(e.target.value) })} /></label><label>On screen (seconds)<input type="number" min={0.5} max={60} step={0.1} value={s.durationS} disabled={busy} onChange={e => scenePatch(i, { durationS: Number(e.target.value) })} /></label></div>
          <div className="row-2"><label>Transition into scene<select value={i === 0 ? "cut" : (s.transition ?? "cut")} disabled={busy || i === 0} onChange={e => scenePatch(i, { transition: e.target.value })}>{Object.entries(TRANSITIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Motion<select value={s.zoom ?? "none"} disabled={busy} onChange={e => scenePatch(i, { zoom: e.target.value })}>{Object.entries(ZOOMS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <label>Look<select value={s.look ?? "none"} disabled={busy} onChange={e => scenePatch(i, { look: e.target.value })}>{Object.entries(LOOKS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {i > 0 && s.transition && s.transition !== "cut" && <label>Transition length ({Number(s.transitionSeconds ?? 0.5).toFixed(2)} seconds)<input type="range" min={0.1} max={2} step={0.05} value={s.transitionSeconds ?? 0.5} disabled={busy} onChange={e => scenePatch(i, { transitionSeconds: Number(e.target.value) })} /></label>}
          <label>On-screen text<input value={s.text} maxLength={120} disabled={busy} onChange={e => scenePatch(i, { text: e.target.value })} /></label>
          {suggested[i] && !s.assetId && <div className="scene-suggestions" aria-label={"Suggested visuals for scene " + (i + 1)}>{suggested[i]!.map((item) => <button key={item.provider + item.id} type="button" className="stock-item" disabled={busy || adding !== ""} onClick={() => void useSuggestion(i, item)} title={item.credit ?? ""}><img src={item.thumbUrl} alt="" loading="lazy" />{item.durationS ? <span className="stock-time mono">{Math.round(item.durationS)}s</span> : null}<span className="stock-add">{adding === i + ":" + item.id ? "Adding…" : "Use"}</span></button>)}</div>}
          {s.assetId && media.find((a) => a.id === s.assetId) && <p className="scene-chosen muted small">{s.thumb && <img src={s.thumb} alt="" />}Visual: {nameOf(media.find((a) => a.id === s.assetId)!)}</p>}
          <div className="actions"><button className="btn" disabled={busy} aria-expanded={sceneIndex === i} onClick={() => { if (sceneIndex === i) { setSceneIndex(null); return; } setSceneIndex(i); setImagePrompt(s.visual); setTimeout(() => document.getElementById("scene-visuals-" + i)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }}>{sceneIndex === i ? "Close visuals" : "Find visuals for scene " + (i + 1)}</button>
            <button className="btn" aria-label={"Move scene " + (i + 1) + " earlier"} disabled={busy || i === 0} onClick={() => { const scenes = [...draft.plan!.scenes]; [scenes[i - 1], scenes[i]] = [scenes[i]!, scenes[i - 1]!]; patch({ plan: { ...draft.plan!, scenes } }); setSceneIndex(null); }}>Move earlier</button>
            <button className="btn" disabled={busy || draft.plan!.scenes.length === 1} onClick={() => { patch({ plan: { ...draft.plan!, scenes: draft.plan!.scenes.filter((_, j) => j !== i) } }); setSceneIndex(null); }}>Remove scene {i + 1}</button></div>
          {sceneIndex === i && scene && <section id={"scene-visuals-" + i} className="scene-visuals stack" aria-label="Scene visuals"><h3>Visual for scene {i + 1}</h3>
        {previewAsset && urls[previewAsset.id] && (previewAsset.kind === "image" ? <img key={urlRetry} className="creation-preview" src={urls[previewAsset.id]} alt={scene.visual || nameOf(previewAsset)} onError={() => setPreviewError(true)} /> : <video key={urlRetry} className="creation-preview" controls playsInline src={urls[previewAsset.id]} onError={() => setPreviewError(true)} />)}
        {previewError && <button className="btn" onClick={() => setUrlRetry(n => n + 1)}>Reload visual preview</button>}
        <p className="muted small">Searching free stock for “{searchOf(scene)}”. Change the words and search again, or pick one: it becomes this scene's visual.</p>
        <StockSearch onWorking={setStockWorking} projectId={projectId} request={request} disabled={busy} orientation={draft.platform === "youtube" ? "landscape" : draft.platform === "square" ? "square" : "portrait"} onUse={a => selectVisual(a as Asset)} initialQuery={searchOf(scene)} hint="Click one to use it for this scene." />
        {images ? <><label>Describe an image<textarea rows={2} value={imagePrompt} maxLength={2000} disabled={busy} onChange={e => setImagePrompt(e.target.value)} /></label><button className="btn" disabled={busy || imagePrompt.trim().length < 3} onClick={() => void run("Generating an image…", async () => { const r = await request("/v1/projects/" + projectId + "/creation/image", { method: "POST", body: JSON.stringify({ prompt: imagePrompt }) }); selectVisual(r.asset); })}>Generate image</button></> : <p className="muted small">Image generation is unavailable. Choose an upload or stock visual.</p>}
          </section>}
        </li>)}</ol>
        {draft.plan.scenes.some((sc) => !sc.assetId) && <button className="primary" disabled={busy} onClick={() => void suggestAll()}>Find visuals for every scene</button>}
        <button className="btn" disabled={busy || draft.plan.scenes.length >= 40} onClick={() => patch({ plan: { ...draft.plan!, scenes: [...draft.plan!.scenes, { assetId: "", startS: 0, durationS: 5, text: "", visual: "", transition: "dissolve", transitionSeconds: 0.5, look: "none", zoom: "none" }] } })}>Add a scene</button>
      </section>
      <section className="card stack" aria-label="Story narration"><h2>4. Choose narration</h2>
        <p className="muted small">Keep the original sound, or add one narration track for the whole story. With narration, source speech is muted and visuals extend to include the complete recording.</p>
        <label>Narration<select aria-label="Narration" value={draft.narrationMode === "ai" ? "__ai" : draft.narrationMode === "none" ? "__none" : draft.narrationId} disabled={busy} onChange={e => patch(e.target.value === "__ai" ? { narrationMode: "ai" } : e.target.value === "__none" ? { narrationMode: "none" } : { narrationMode: "existing", narrationId: e.target.value })}><option value="__ai">AI voice from the reviewed script</option><option value="__none">Keep original sound / no narration</option><option value="" disabled>Choose a recording</option>{assets.filter(a => a.kind === "audio" && !a.metadata.mood).map(a => <option key={a.id} value={a.id}>{nameOf(a)}</option>)}</select></label>
        <label className="btn file-btn">Upload human narration<input type="file" accept="audio/*" disabled={busy} onChange={e => void upload(e.currentTarget, true)} /></label>
        {draft.narrationMode === "ai" && <p className="note">Your AI voice is generated automatically when you assemble. You can preview it first with the button below. Editing the script, voice, or delivery makes a new recording.</p>}
        {narration && draft.narrationMode !== "none" && <p className="muted small">Selected audio: {nameOf(narration)}</p>}
        {narration && draft.narrationMode !== "none" && urls[narration.id] && <audio controls src={urls[narration.id]} />}
        <VoiceOver projectId={projectId} apiBase={apiBase} token={token} request={request} disabled={Boolean(working)} initialScript={draft.plan.script} initialVoice={draft.voice} initialStyle={draft.voiceStyle} onVoiceChange={voice => patch({ voice })} onStyleChange={voiceStyle => patch({ voiceStyle })} placement="story" onWorking={setVoiceWorking} onScriptChange={script => { patch({ plan: { ...draft.plan!, script } }); const preferredSentenceWords = sentenceWords(script); if (preferredSentenceWords) setPreferences(p => ({ ...p, preferredSentenceWords })); }} onRecording={setRecording} onAdd={a => { onAsset(a); const ai = a.metadata.voiceover === true; patch({ narrationId: a.id, narrationMode: ai ? "ai" : "existing", narrationFingerprint: ai ? JSON.stringify([draft.plan!.script.trim(), draft.voice, draft.voiceStyle.trim()]) : "" }); }} />
        {draft.narrationMode !== "none" && <label className="checkbox"><input type="checkbox" checked={draft.captions} disabled={busy} onChange={e => patch({ captions: e.target.checked })} />Transcribe narration and add speech captions</label>}
        <label className="checkbox"><input type="checkbox" checked={draft.music} disabled={busy} onChange={e => patch({ music: e.target.checked })} />Add background music</label>
        <label className="checkbox"><input type="checkbox" checked={draft.sceneText} disabled={busy} onChange={e => patch({ sceneText: e.target.checked })} />Include approved scene text</label>
      </section>
      {revision > 0 && <p className="note">This becomes a new revision. Your current edit remains available through Undo.</p>}
      <section className={"readiness " + (ready ? "ready" : "waiting")} aria-label="First cut readiness"><div><span className="eyebrow">Ready check</span><strong>{ready ? "Everything is in place" : openScenes ? openScenes + " scene" + (openScenes === 1 ? " needs" : "s need") + " a visual" : "Finish the narration choice"}</strong><p className="muted small">The complete edit opens next for playback, refinement, and one final professional review.</p></div><button className="primary" disabled={busy || !ready || draft.plan.scenes.some(s => !s.assetId || !media.some(a => a.id === s.assetId))} onClick={() => void assemble()}>Build the first cut</button></section>
    </>}
    {(working || notice) && <p role={notice ? "alert" : "status"}>{working || notice}</p>}
  </main>;
}
