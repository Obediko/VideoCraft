import { useEffect, useState } from "react";

/** Free stock videos, photos and GIFs (Pexels, Pixabay, GIPHY) to use as cutaways. Searches go through the server. */
type Item = { provider: "pexels" | "pixabay" | "giphy"; id: string; kind: "video" | "photo" | "gif"; thumbUrl: string; previewUrl?: string; width: number; height: number; durationS?: number; title?: string; credit?: string; pageUrl?: string };
type Sources = { video: string[]; photo: string[]; gif: string[] };
type Props = {
  projectId: string;
  request(path: string, init?: RequestInit): Promise<any>;
  orientation: "portrait" | "landscape" | "square";
  disabled: boolean;
  /** Called with the stored asset; the editor adds it as a cutaway. */
  onUse(asset: { id: string; kind: string; metadata: Record<string, string | number | boolean> } & Record<string, unknown>): void;
};
const LIBRARY: Record<string, string> = { pexels: "Pexels", pixabay: "Pixabay", giphy: "GIPHY" };

export function StockSearch({ projectId, request, orientation, disabled, onUse }: Props) {
  const [sources, setSources] = useState<Sources | null>(null);
  const [kind, setKind] = useState<"video" | "photo" | "gif">("video");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [note, setNote] = useState("");
  const [working, setWorking] = useState("");

  useEffect(() => {
    let cancelled = false;
    request("/v1/projects/" + projectId + "/stock/sources").then((value) => { if (!cancelled) setSources(value); }).catch(() => { if (!cancelled) setSources({ video: [], photo: [], gif: [] }); });
    return () => { cancelled = true; };
  }, [projectId]);

  if (!sources) return null;
  const available = sources[kind];
  const any = sources.video.length + sources.photo.length + sources.gif.length > 0;
  if (!any) return <p className="muted small">Stock search is off: add a free Pexels, Pixabay or GIPHY key on the server to search them here.</p>;

  async function search(event?: { preventDefault(): void }) {
    event?.preventDefault();
    if (!query.trim()) return;
    setWorking("search"); setNote("");
    try {
      const result = await request("/v1/projects/" + projectId + "/stock/search?kind=" + kind + "&orientation=" + orientation + "&q=" + encodeURIComponent(query.trim()));
      setItems(result.items ?? []);
      if (!result.items?.length) setNote("Nothing found. Try other words.");
    } catch (caught) { setItems([]); setNote(caught instanceof Error ? caught.message : "Search failed"); }
    finally { setWorking(""); }
  }
  async function use(item: Item) {
    setWorking(item.provider + ":" + item.id); setNote("");
    try {
      const result = await request("/v1/projects/" + projectId + "/stock/import", { method: "POST", body: JSON.stringify({ provider: item.provider, kind: item.kind, id: item.id }) });
      onUse(result.asset);
    } catch (caught) { setNote(caught instanceof Error ? caught.message : "Could not add it"); }
    finally { setWorking(""); }
  }

  return <div className="stock stack">
    <div className="segmented" role="tablist" aria-label="Stock type">
      {(["video", "photo", "gif"] as const).filter((k) => sources[k].length > 0).map((k) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); setItems([]); setNote(""); }}>{k === "video" ? "Videos" : k === "photo" ? "Photos" : "GIFs"}</button>)}
    </div>
    <form className="stock-form" onSubmit={(event) => void search(event)}>
      <input aria-label="Search stock" placeholder={kind === "gif" ? "e.g. applause, mind blown" : "e.g. city at night, typing on a laptop"} value={query} onChange={(event) => setQuery(event.target.value)} />
      <button className="btn" type="submit" disabled={disabled || working !== "" || !query.trim() || available.length === 0}>{working === "search" ? "Searching…" : "Search"}</button>
    </form>
    {note && <p className="muted small" role="status">{note}</p>}
    {items.length > 0 && <ul className="stock-grid" aria-label="Stock results">
      {items.map((item) => { const key = item.provider + ":" + item.id; return <li key={key}>
        <button type="button" className="stock-item" title={(item.title ? item.title + " · " : "") + (item.credit ? item.credit + " on " : "") + LIBRARY[item.provider]} onClick={() => void use(item)} disabled={disabled || working !== ""} aria-label={"Add " + (item.title || item.kind) + " from " + LIBRARY[item.provider]}>
          <img src={item.thumbUrl} alt="" loading="lazy" />
          {item.durationS ? <span className="stock-time mono">{Math.round(item.durationS)}s</span> : null}
          <span className="stock-add">{working === key ? "Adding…" : "Add"}</span>
        </button>
      </li>; })}
    </ul>}
    <p className="muted small">{available.map((p) => LIBRARY[p]).join(" and ")}{kind === "gif" ? " · Powered by GIPHY" : " · free to use, credit appreciated"}. Click one to add it at the playhead or the selected words.</p>
  </div>;
}
