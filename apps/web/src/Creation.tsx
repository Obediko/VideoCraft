import { useEffect, useState } from "react";
import { StockSearch } from "./StockSearch.js";
import { VoiceOver } from "./VoiceOver.js";

export type CreationMode = "footage" | "story" | "idea";
type Asset = { id: string; kind: string; durationUs?: number; metadata: Record<string, string | number | boolean> };
type Scene = { assetId: string; startS: number; durationS: number; text: string; visual: string };
type Plan = { summary: string; script: string; scenes: Scene[]; source: "ai" | "rules"; note?: string };
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
  const busy = Boolean(working || recording || voiceWorking || stockWorking);
  const media = assets.filter(a => a.kind === "image" || a.kind === "video");
  const narration = assets.find(a => a.id === draft.narrationId);
  const patch = (change: Partial<Draft>) => setDraft(d => ({ ...d, ...change }));
  useEffect(() => { try { localStorage.setItem(keyOf(projectId), JSON.stringify(draft)); } catch { /* editing remains available */ } }, [projectId, draft]);
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
      const result = await request("/v1/projects/" + projectId + "/creation/plan", { method: "POST", body: JSON.stringify({ brief: draft.brief, seconds: draft.seconds, assetIds: draft.selected.filter(id => media.some(a => a.id === id)) }) });
      patch({ plan: result.plan }); setSceneIndex(null);
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
  return <main className="page creation stack">
    <div><h1>{mode === "idea" ? "Create from an idea" : "Tell a story"}</h1><p className="muted">Describe it, gather your visuals, then approve a storyboard and narration.</p></div>
    <section className="card stack" aria-label="Story brief">
      <h2>1. Describe the result</h2>
      <label>Your brief<textarea rows={3} maxLength={2000} value={draft.brief} disabled={busy} onChange={e => patch({ brief: e.target.value })} placeholder="What is it about, who is it for, and what should viewers take away?" /></label>
      <label>Narration preference<select aria-label="Narration preference" value={draft.narrationMode} disabled={busy} onChange={e => patch({ narrationMode: e.target.value as NarrationMode })}><option value="ai">AI-generated narration</option><option value="existing">Record or upload my narration</option><option value="none">Keep original sound / no narration</option></select></label>
      {draft.narrationMode === "ai" && <p className="muted small">AI drafts the narration script with your storyboard. Review the words and voice below; assembling generates and adds the audio automatically.</p>}
      <div className="row-2"><label>Target length (seconds)<input type="number" min={5} max={600} value={draft.seconds} disabled={busy} onChange={e => patch({ seconds: Number(e.target.value) })} /></label>
        <label>Format<select value={draft.platform} disabled={busy} onChange={e => patch({ platform: e.target.value })}><option value="tiktok">Reel / Short · 9:16</option><option value="youtube">YouTube · 16:9</option><option value="square">Feed · 1:1</option></select></label></div>
    </section>
    <section className="card stack" aria-label="Story media">
      <h2>2. Gather videos and photos</h2>
      <p className="muted small">Use uploads, stock, or generated images. With no uploads, the storyboard will suggest visuals for you to choose.</p>
      <label className="btn file-btn">Upload videos and photos<input aria-label="Upload videos and photos" type="file" multiple accept="video/*,image/*" disabled={busy} onChange={e => void upload(e.currentTarget)} /></label>
      <div className="creation-library">{media.map(a => <label className="checkbox" key={a.id}><input type="checkbox" disabled={busy} checked={draft.selected.includes(a.id)} onChange={e => patch({ selected: e.target.checked ? [...draft.selected, a.id] : draft.selected.filter(id => id !== a.id) })} />{a.kind === "image" ? "Photo" : "Video"} · {nameOf(a)}</label>)}</div>
      <button className="primary" type="button" disabled={busy || draft.brief.trim().length < 3 || draft.seconds < 5 || draft.seconds > 600} onClick={() => void plan()}>{draft.plan ? "Make a new storyboard" : "Make my storyboard"}</button>
      {draft.plan && <p className="muted small">A new storyboard replaces the draft below. Your uploads and narration stay available.</p>}
    </section>
    {draft.plan && <>
      <section className="card stack" aria-label="Storyboard">
        <h2>3. Review the storyboard</h2><p>{draft.plan.summary}</p><p className="muted small">{draft.plan.source === "ai" ? "AI storyboard" : "Built-in storyboard"} · {draft.plan.scenes.reduce((n, s) => n + s.durationS, 0).toFixed(1)} seconds before narration timing</p>
        {draft.plan.note && <p role="status">{draft.plan.note}</p>}
        <ol className="creation-scenes">{draft.plan.scenes.map((s, i) => <li key={i} className="stack">
          <strong>Scene {i + 1}: {s.visual || "Choose a visual"}</strong>
          <label>Visual<select aria-label="Visual" value={s.assetId} disabled={busy} onChange={e => { const a = media.find(a => a.id === e.target.value); scenePatch(i, { assetId: e.target.value, startS: 0, durationS: Math.min(s.durationS, a?.kind === "video" ? (a.durationUs ?? 5e6) / 1e6 : 60) }); }}><option value="">Choose a visual</option>{media.map(a => <option key={a.id} value={a.id}>{nameOf(a)}</option>)}</select></label>
          <div className="row-2"><label>Start in source (seconds)<input type="number" min={0} step={0.1} disabled={busy || media.find(a => a.id === s.assetId)?.kind === "image"} value={s.startS} onChange={e => scenePatch(i, { startS: Number(e.target.value) })} /></label><label>On screen (seconds)<input type="number" min={0.5} max={60} step={0.1} value={s.durationS} disabled={busy} onChange={e => scenePatch(i, { durationS: Number(e.target.value) })} /></label></div>
          <label>On-screen text<input value={s.text} maxLength={120} disabled={busy} onChange={e => scenePatch(i, { text: e.target.value })} /></label>
          <div className="actions"><button className="btn" disabled={busy} onClick={() => { setSceneIndex(i); setImagePrompt(s.visual); }}>Preview / find visuals for scene {i + 1}</button>
            <button className="btn" aria-label={"Move scene " + (i + 1) + " earlier"} disabled={busy || i === 0} onClick={() => { const scenes = [...draft.plan!.scenes]; [scenes[i - 1], scenes[i]] = [scenes[i]!, scenes[i - 1]!]; patch({ plan: { ...draft.plan!, scenes } }); setSceneIndex(null); }}>Move earlier</button>
            <button className="btn" disabled={busy || draft.plan!.scenes.length === 1} onClick={() => { patch({ plan: { ...draft.plan!, scenes: draft.plan!.scenes.filter((_, j) => j !== i) } }); setSceneIndex(null); }}>Remove scene {i + 1}</button></div>
        </li>)}</ol>
        <button className="btn" disabled={busy || draft.plan.scenes.length >= 40} onClick={() => patch({ plan: { ...draft.plan!, scenes: [...draft.plan!.scenes, { assetId: "", startS: 0, durationS: 5, text: "", visual: "" }] } })}>Add a scene</button>
      </section>
      {scene && <section className="card stack" aria-label="Scene visuals"><h2>Visual for scene {sceneIndex! + 1}</h2>
        {previewAsset && urls[previewAsset.id] && (previewAsset.kind === "image" ? <img key={urlRetry} className="creation-preview" src={urls[previewAsset.id]} alt={scene.visual || nameOf(previewAsset)} onError={() => setPreviewError(true)} /> : <video key={urlRetry} className="creation-preview" controls playsInline src={urls[previewAsset.id]} onError={() => setPreviewError(true)} />)}
        {previewError && <button className="btn" onClick={() => setUrlRetry(n => n + 1)}>Reload visual preview</button>}
        <p className="muted small">Search idea: {scene.visual}. Adding stock or generating an image assigns it to this scene.</p>
        <StockSearch onWorking={setStockWorking} projectId={projectId} request={request} disabled={busy} orientation={draft.platform === "youtube" ? "landscape" : draft.platform === "square" ? "square" : "portrait"} onUse={a => selectVisual(a as Asset)} />
        {images ? <><label>Describe an image<textarea rows={2} value={imagePrompt} maxLength={2000} disabled={busy} onChange={e => setImagePrompt(e.target.value)} /></label><button className="btn" disabled={busy || imagePrompt.trim().length < 3} onClick={() => void run("Generating an image…", async () => { const r = await request("/v1/projects/" + projectId + "/creation/image", { method: "POST", body: JSON.stringify({ prompt: imagePrompt }) }); selectVisual(r.asset); })}>Generate image</button></> : <p className="muted small">Image generation is unavailable. Choose an upload or stock visual.</p>}
      </section>}
      <section className="card stack" aria-label="Story narration"><h2>4. Choose narration</h2>
        <p className="muted small">Keep the original sound, or add one narration track for the whole story. With narration, source speech is muted and visuals extend to include the complete recording.</p>
        <label>Narration<select aria-label="Narration" value={draft.narrationMode === "ai" ? "__ai" : draft.narrationMode === "none" ? "__none" : draft.narrationId} disabled={busy} onChange={e => patch(e.target.value === "__ai" ? { narrationMode: "ai" } : e.target.value === "__none" ? { narrationMode: "none" } : { narrationMode: "existing", narrationId: e.target.value })}><option value="__ai">AI voice from the reviewed script</option><option value="__none">Keep original sound / no narration</option><option value="" disabled>Choose a recording</option>{assets.filter(a => a.kind === "audio" && !a.metadata.mood).map(a => <option key={a.id} value={a.id}>{nameOf(a)}</option>)}</select></label>
        <label className="btn file-btn">Upload human narration<input type="file" accept="audio/*" disabled={busy} onChange={e => void upload(e.currentTarget, true)} /></label>
        {draft.narrationMode === "ai" && <p className="note">Your AI voice is generated automatically when you assemble. You can preview it first with the button below. Editing the script, voice, or delivery makes a new recording.</p>}
        {narration && draft.narrationMode !== "none" && <p className="muted small">Selected audio: {nameOf(narration)}</p>}
        {narration && draft.narrationMode !== "none" && urls[narration.id] && <audio controls src={urls[narration.id]} />}
        <VoiceOver projectId={projectId} apiBase={apiBase} token={token} request={request} disabled={Boolean(working)} initialScript={draft.plan.script} initialVoice={draft.voice} initialStyle={draft.voiceStyle} onVoiceChange={voice => patch({ voice })} onStyleChange={voiceStyle => patch({ voiceStyle })} placement="story" onWorking={setVoiceWorking} onScriptChange={script => patch({ plan: { ...draft.plan!, script } })} onRecording={setRecording} onAdd={a => { onAsset(a); const ai = a.metadata.voiceover === true; patch({ narrationId: a.id, narrationMode: ai ? "ai" : "existing", narrationFingerprint: ai ? JSON.stringify([draft.plan!.script.trim(), draft.voice, draft.voiceStyle.trim()]) : "" }); }} />
        {draft.narrationMode !== "none" && <label className="checkbox"><input type="checkbox" checked={draft.captions} disabled={busy} onChange={e => patch({ captions: e.target.checked })} />Transcribe narration and add speech captions</label>}
        <label className="checkbox"><input type="checkbox" checked={draft.music} disabled={busy} onChange={e => patch({ music: e.target.checked })} />Add background music</label>
        <label className="checkbox"><input type="checkbox" checked={draft.sceneText} disabled={busy} onChange={e => patch({ sceneText: e.target.checked })} />Include approved scene text</label>
      </section>
      {revision > 0 && <p className="note">Assembling replaces the current edit with this storyboard. Previous revisions remain available through Undo.</p>}
      <div className="actions"><button className="primary" disabled={busy || !draft.plan.scenes.length || draft.plan.scenes.some(s => !s.assetId || !media.some(a => a.id === s.assetId))} onClick={() => void assemble()}>Assemble this story</button><span className="muted small">The editor opens for playback, captions, transitions, and export.</span></div>
    </>}
    {(working || notice) && <p role={notice ? "alert" : "status"}>{working || notice}</p>}
  </main>;
}
