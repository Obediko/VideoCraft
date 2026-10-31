import { useEffect, useRef, useState } from "react";
import { SOUND_EFFECTS, CLIP_ZOOMS, EFFECT_PRESETS, parseEffectRecipe, type EffectRecipe, type SavedEffect } from "@videocraft/domain";

type Props = {
  projectId: string;
  revision: number;
  request(path: string, init?: RequestInit): Promise<any>;
  refreshKey?: number;
  disabled: boolean;
  onUse(recipe: EffectRecipe, atUs?: number): Promise<boolean>;
};
export function EffectLibrary({ request, disabled, onUse, refreshKey, projectId, revision }: Props) {
  const [saved, setSaved] = useState<SavedEffect[]>([]);
  const [recipe, setRecipe] = useState<EffectRecipe>(() => parseEffectRecipe({ presetId: "key-point" }));
  const [query, setQuery] = useState("");
  const [remember, setRemember] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [direction, setDirection] = useState("");
  const [ideas, setIdeas] = useState<{revision:number;note:string;source:string;proposals:Array<{id:string;title:string;reason:string;atUs:number;recipe:EffectRecipe;stockPreview?:{thumbUrl:string;credit?:string;provider:string}}>}>();
  const requestRef = useRef(request); requestRef.current = request;
  useEffect(() => {
    let active = true;
    void requestRef.current("/v1/me/effects").then(result => {
      if (active) { setSaved(result.saved ?? []); setLoadError(false); }
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [reload, refreshKey]);
  const preset = EFFECT_PRESETS.find(p => p.id === recipe.presetId) ?? { name: "Stock cutaway", description: "Reuse the stock item accepted in an earlier project. It is imported from its provider when you add it here." };
  const clipTreatment = ["focus", "impact", "smooth-reveal"].includes(recipe.presetId);
  async function save(chosen = recipe) {
    const result = await requestRef.current("/v1/me/effects", { method: "POST", body: JSON.stringify(parseEffectRecipe(chosen)) });
    setSaved(items => [result.effect, ...items.filter(item => item.id !== result.effect.id)].slice(0, 100));
  }
  async function useEffectRecipe(chosen = recipe, atUs?: number) {
    setWorking(true); setMessage("");
    try {
      if (!await onUse(chosen, atUs)) return;
      if (remember) {
        try { await save(chosen); setMessage("Treatment added and saved to your library."); }
        catch { setMessage("Treatment added. Library save failed; use Save treatment to retry."); }
      } else setMessage("Treatment added. Undo is available in the editor.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not add this treatment"); }
    finally { setWorking(false); }
  }
  async function planTreatments() {
    setWorking(true); setMessage("");
    try { setIdeas(await requestRef.current("/v1/projects/" + projectId + "/creative/plan", { method: "POST", body: JSON.stringify({ revision, brief: direction }) })); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Creative planning failed. Try again."); }
    finally { setWorking(false); }
  }
  const locked = disabled || working;
  return <section className="effect-library stack" aria-label="Creative effects library">
    <h3>Creative treatments</h3>
    <p className="muted small">Choose a treatment for this moment. The Director can suggest these too; accepted treatments grow your private library.</p>
    <label>Creative direction<input value={direction} maxLength={600} disabled={locked} placeholder="Subtle documentary, playful reactions, energetic launch…" onChange={e => setDirection(e.target.value)} /></label>
    <button type="button" className="btn" disabled={locked || revision === 0} onClick={() => void planTreatments()}>{working ? "Working…" : "Ask Director for creative treatments"}</button>
    {ideas && <div className="stack" role="region" aria-label="Director creative suggestions">
      <p className="muted small">{ideas.note}</p>
      {ideas.revision !== revision && <p className="muted small">Your edit changed. Ask for new ideas before applying another suggestion.</p>}
      {ideas.proposals.length === 0 && <p>No additional treatments suggested. You can choose one below.</p>}
      {ideas.proposals.map(idea => <article key={idea.id} className="suggestion stack"><strong>{idea.title}</strong><p>{idea.reason}</p><span className="mono small">At {(idea.atUs / 1e6).toFixed(1)} s · {idea.recipe.durationS} s</span>{idea.stockPreview && <div className="stock-pick"><img src={idea.stockPreview.thumbUrl} alt={idea.recipe.text} /><span>{idea.stockPreview.credit ?? idea.stockPreview.provider}</span></div>}<button type="button" className="btn" disabled={locked || ideas.revision !== revision} onClick={() => { setRecipe(idea.recipe); void useEffectRecipe(idea.recipe,idea.atUs); }}>Apply treatment: {idea.title}</button></article>)}
    </div>}
    <label>Find a treatment<input type="search" value={query} placeholder="Motion, sound, reactions, titles…" onChange={e => setQuery(e.target.value)} /></label>
    <div className="effect-preset-grid">{EFFECT_PRESETS.filter(p => (p.name + " " + p.tags.join(" ")).toLowerCase().includes(query.trim().toLowerCase())).map(p => <button type="button" key={p.id} className={"btn effect-preset" + (recipe.presetId === p.id ? " selected" : "")} aria-pressed={recipe.presetId === p.id} disabled={locked} onClick={() => setRecipe(parseEffectRecipe({ presetId: p.id }))}><strong>{p.name}</strong><span className="muted small">{p.tags.join(" · ")}</span></button>)}</div>
    <p>{preset.description}</p>
    {!clipTreatment && recipe.presetId !== "thinking" && !recipe.stock && <label>Treatment text<input maxLength={80} value={recipe.text} disabled={locked} onChange={e => setRecipe(r => ({ ...r, text: e.target.value }))} /></label>}
    {!clipTreatment && <>
      <label>Treatment colour<input type="color" value={recipe.color} disabled={locked} onChange={e => setRecipe(r => ({ ...r, color: e.target.value }))} /></label>
      <label>Treatment length (seconds)<input type="number" min={1} max={6} step={0.25} value={recipe.durationS} disabled={locked} onChange={e => setRecipe(r => ({ ...r, durationS: Number(e.target.value) }))} /></label>
    </>}
    <label>Companion sound<select value={recipe.sound ?? "none"} disabled={locked} onChange={e => setRecipe(r => ({ ...r, sound: e.target.value as NonNullable<EffectRecipe["sound"]> }))}><option value="none">None</option>{SOUND_EFFECTS.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
    <label>Clip motion<select value={recipe.zoom ?? "none"} disabled={locked} onChange={e => setRecipe(r => ({ ...r, zoom: e.target.value as NonNullable<EffectRecipe["zoom"]> }))}>{CLIP_ZOOMS.map(s => <option key={s} value={s}>{s === "none" ? "Keep current motion" : s === "push" ? "Slow push-in" : "Tighter framing"}</option>)}</select></label>
    <label className="checkbox"><input type="checkbox" checked={remember} disabled={locked} onChange={e => setRemember(e.target.checked)} /> Save this treatment for future projects</label>
    <button type="button" className="btn" disabled={locked || !recipe.text.trim()} onClick={() => void useEffectRecipe()}>Add treatment at this moment</button>
    <button type="button" className="btn" disabled={locked || !recipe.text.trim()} onClick={() => { setWorking(true); void save().then(() => setMessage("Treatment saved.")).catch(() => setMessage("Could not save treatment. Try again.")).finally(() => setWorking(false)); }}>Save treatment</button>
    {message && <p role="status">{message}</p>}
    <h4>Your saved treatments</h4>
    {loadError ? <p role="alert">Your library could not be loaded. <button type="button" className="btn" onClick={() => setReload(n => n + 1)}>Retry library</button></p> : saved.length === 0 ? <p className="muted small">Save a treatment or accept a Director treatment to start your library.</p> : <ul className="item-list">{saved.map(item => <li key={item.id}><button type="button" className="btn" disabled={locked} onClick={() => { setRecipe(item.recipe); setMessage("Saved treatment selected. Choose where to add it."); }}>{EFFECT_PRESETS.find(p => p.id === item.recipe.presetId)?.name ?? "Stock cutaway"} · {item.recipe.text}</button><button type="button" className="btn" aria-label={"Delete saved treatment " + item.recipe.text} disabled={locked} onClick={() => { setWorking(true); void requestRef.current("/v1/me/effects/" + item.id, { method: "DELETE" }).then(() => { setSaved(items => items.filter(i => i.id !== item.id)); setMessage("Saved treatment deleted. Existing edits keep it."); }).catch(() => setMessage("Could not delete treatment. Try again.")).finally(() => setWorking(false)); }}>Delete</button></li>)}</ul>}
    <p className="muted small">Original procedural treatments. No personal footage is saved in this library. Clip motion and transitions apply across the chosen clip.</p>
  </section>;
}
