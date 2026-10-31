import { useEffect, useRef, useState } from "react";
import { SOUND_EFFECTS, CLIP_ZOOMS, EFFECT_PRESETS, parseEffectRecipe, type EffectRecipe, type SavedEffect } from "@videocraft/domain";

type Props = {
  request(path: string, init?: RequestInit): Promise<any>;
  disabled: boolean;
  onUse(recipe: EffectRecipe): Promise<boolean>;
};
export function EffectLibrary({ request, disabled, onUse }: Props) {
  const [saved, setSaved] = useState<SavedEffect[]>([]);
  const [recipe, setRecipe] = useState<EffectRecipe>(() => parseEffectRecipe({ presetId: "key-point" }));
  const [query, setQuery] = useState("");
  const [remember, setRemember] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const requestRef = useRef(request); requestRef.current = request;
  useEffect(() => {
    let active = true;
    void requestRef.current("/v1/me/effects").then(result => {
      if (active) { setSaved(result.saved ?? []); setLoadError(false); }
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [reload]);
  const preset = EFFECT_PRESETS.find(p => p.id === recipe.presetId)!;
  const clipTreatment = ["focus", "impact", "smooth-reveal"].includes(recipe.presetId);
  async function save() {
    const result = await requestRef.current("/v1/me/effects", { method: "POST", body: JSON.stringify(parseEffectRecipe(recipe)) });
    setSaved(items => [result.effect, ...items.filter(item => item.id !== result.effect.id)].slice(0, 100));
  }
  async function useEffectRecipe() {
    setWorking(true); setMessage("");
    try {
      if (!await onUse(recipe)) return;
      if (remember) {
        try { await save(); setMessage("Treatment added and saved to your library."); }
        catch { setMessage("Treatment added. Library save failed; use Save treatment to retry."); }
      } else setMessage("Treatment added. Undo is available in the editor.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not add this treatment"); }
    finally { setWorking(false); }
  }
  const locked = disabled || working;
  return <section className="effect-library stack" aria-label="Creative effects library">
    <h3>Creative treatments</h3>
    <p className="muted small">Choose a treatment for this moment. The Director can suggest these too; accepted treatments grow your private library.</p>
    <label>Find a treatment<input type="search" value={query} placeholder="Motion, sound, reactions, titles…" onChange={e => setQuery(e.target.value)} /></label>
    <div className="effect-preset-grid">{EFFECT_PRESETS.filter(p => (p.name + " " + p.tags.join(" ")).toLowerCase().includes(query.trim().toLowerCase())).map(p => <button type="button" key={p.id} className={"btn effect-preset" + (recipe.presetId === p.id ? " selected" : "")} aria-pressed={recipe.presetId === p.id} disabled={locked} onClick={() => setRecipe(parseEffectRecipe({ presetId: p.id }))}><strong>{p.name}</strong><span className="muted small">{p.tags.join(" · ")}</span></button>)}</div>
    <p>{preset.description}</p>
    {!clipTreatment && recipe.presetId !== "thinking" && <label>Treatment text<input maxLength={80} value={recipe.text} disabled={locked} onChange={e => setRecipe(r => ({ ...r, text: e.target.value }))} /></label>}
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
    {loadError ? <p role="alert">Your library could not be loaded. <button type="button" className="btn" onClick={() => setReload(n => n + 1)}>Retry library</button></p> : saved.length === 0 ? <p className="muted small">Save a treatment or accept a Director treatment to start your library.</p> : <ul className="item-list">{saved.map(item => <li key={item.id}><button type="button" className="btn" disabled={locked} onClick={() => { setRecipe(item.recipe); setMessage("Saved treatment selected. Choose where to add it."); }}>{EFFECT_PRESETS.find(p => p.id === item.recipe.presetId)?.name} · {item.recipe.text}</button><button type="button" className="btn" aria-label={"Delete saved treatment " + item.recipe.text} disabled={locked} onClick={() => { setWorking(true); void requestRef.current("/v1/me/effects/" + item.id, { method: "DELETE" }).then(() => { setSaved(items => items.filter(i => i.id !== item.id)); setMessage("Saved treatment deleted. Existing edits keep it."); }).catch(() => setMessage("Could not delete treatment. Try again.")).finally(() => setWorking(false)); }}>Delete</button></li>)}</ul>}
    <p className="muted small">Original procedural treatments. No personal footage is saved in this library. Clip motion and transitions apply across the chosen clip.</p>
  </section>;
}
