import { useMemo, useState, type KeyboardEvent } from "react";

type TimelineClip = {
  id: string;
  assetId: string;
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs: number;
  timelineEndUs: number;
};
type Timeline = { durationUs: number; tracks: Array<{ id: string; kind: string; clips: TimelineClip[] }> };
type Proposal = { id: string; rationale: string; confidence: number; evidence: Array<{ source: string; reference: string; excerpt?: string }>; operations: unknown[]; status: string };

const API = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";

export function App() {
  const [token, setToken] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("My first cut");
  const [intent, setIntent] = useState("Create a clear short-form explainer");
  const [audience, setAudience] = useState("People discovering the product");
  const [channel, setChannel] = useState("short-form");
  const [timeline, setTimeline] = useState<Timeline>({ durationUs: 30_000_000, tracks: [] });
  const [assetId, setAssetId] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [uploadKind, setUploadKind] = useState("video");
  const [renderJobId, setRenderJobId] = useState("");
  const [renderJobStatus, setRenderJobStatus] = useState("");
  const [renderUrl, setRenderUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState("");

  const videoTrack = useMemo(() => timeline.tracks.find((track) => track.kind === "video"), [timeline]);

  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(API + path, {
      ...init,
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...init.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message ?? "Request failed");
    return body;
  }

  async function createProject() {
    setBusy(true);
    try {
      const result = await request("/v1/projects", { method: "POST", body: JSON.stringify({ name: projectName }) });
      setProjectId(result.project.id);
      setStatus("Project created");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function uploadAsset(event: { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    if (!file || !projectId) { setStatus(projectId ? "Choose a media file first" : "Create a project first"); return; }
    setBusy(true);
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch(API + "/v1/projects/" + projectId + "/assets/upload?kind=" + encodeURIComponent(uploadKind), { method: "POST", body: form, headers: token ? { authorization: "Bearer " + token } : {} });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message ?? "Upload failed");
      setAssetId(body.asset.id); setStatus("Uploaded asset " + body.asset.id.slice(0, 8));
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); event.currentTarget.value = ""; }
  }

  async function pollRender(id: string) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const result = await request("/v1/projects/" + projectId + "/renders/" + id);
        setRenderJobStatus(result.job.status + " " + result.job.progress + "%");
        if (result.job.status === "succeeded") { const download = await request("/v1/projects/" + projectId + "/renders/" + id + "/download-url"); setRenderUrl(API + download.url); setStatus("Render succeeded"); return; }
        if (["failed", "cancelled"].includes(result.job.status)) { setStatus("Render " + result.job.status); return; }
      } catch (error) { setStatus(errorMessage(error)); return; }
    }
  }

  function addClip() {
    if (!assetId.trim()) { setStatus("Register an asset and enter its asset ID first"); return; }
    const clip: TimelineClip = {
      id: "clip-" + Date.now(),
      assetId: assetId.trim(),
      sourceStartUs: 0,
      sourceEndUs: 10_000_000,
      timelineStartUs: 0,
      timelineEndUs: 10_000_000,
    };
    setSelectedClipId(clip.id);
    setTimeline((current) => ({
      ...current,
      tracks: current.tracks.some((track) => track.kind === "video")
        ? current.tracks.map((track) => track.kind === "video" ? { ...track, clips: [...track.clips, clip] } : track)
        : [...current.tracks, { id: "video-1", kind: "video", clips: [clip] }],
    }));
    setStatus("Clip added to the non-destructive timeline");
  }

  function nudgeSelectedClip(deltaUs: number) {
    if (!selectedClipId) { setStatus("Select a clip first"); return; }
    setTimeline((current) => ({
      ...current,
      tracks: current.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip;
          const duration = clip.timelineEndUs - clip.timelineStartUs;
          const nextStart = Math.max(0, Math.min(current.durationUs - duration, clip.timelineStartUs + deltaUs));
          return { ...clip, timelineStartUs: nextStart, timelineEndUs: nextStart + duration };
        }),
      })),
    }));
    setStatus(deltaUs < 0 ? "Clip moved earlier" : "Clip moved later");
  }

  function removeSelectedClip() {
    if (!selectedClipId) { setStatus("Select a clip first"); return; }
    setTimeline((current) => ({ ...current, tracks: current.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== clipId) })) }));
    setSelectedClipId("");
    setStatus("Clip removed from the non-destructive timeline");
  }

  function handleClipKeyDown(event: KeyboardEvent<HTMLButtonElement>, clip: TimelineClip) {
    if (event.key === "ArrowLeft") { event.preventDefault(); setSelectedClipId(clip.id); nudgeSelectedClip(-500_000, clip.id); }
    if (event.key === "ArrowRight") { event.preventDefault(); setSelectedClipId(clip.id); nudgeSelectedClip(500_000, clip.id); }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); setSelectedClipId(clip.id); removeSelectedClip(clip.id); }
  }

  async function saveRevision() {
    if (!projectId) { setStatus("Create a project first"); return; }
    setBusy(true);
    try {
      const result = await request("/v1/projects/" + projectId + "/revisions", { method: "POST", body: JSON.stringify({ timeline }) });
      setRevision(result.revision.revision);
      setStatus("Revision " + result.revision.revision + " saved");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function analyzeBrief() {
    if (!projectId) { setStatus("Create a project first"); return; }
    setBusy(true);
    try {
      const result = await request("/v1/projects/" + projectId + "/intent/analyze", { method: "POST", body: JSON.stringify({ prompt: intent }) });
      const profile = result.analysis.profile; setIntent(profile.intent); setAudience(profile.audience); setChannel(profile.channel); setStatus("Brief analyzed into a tailoring profile");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function previewProposal() {
    if (!projectId || !revision) { setStatus("Save a revision before requesting a proposal"); return; }
    setBusy(true);
    try {
      const result = await request("/v1/projects/" + projectId + "/proposals", {
        method: "POST",
        body: JSON.stringify({ revision, strategyId: "short-form-explainer", profile: { intent, audience, channel, constraints: [] } }),
      });
      setProposal(result.proposal);
      setStatus("Proposal ready for review");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function decideProposal(decision: "accepted" | "rejected") {
    if (!projectId || !proposal) return;
    setBusy(true);
    try {
      const result = await request("/v1/projects/" + projectId + "/proposals/" + proposal.id + "/decision", { method: "POST", body: JSON.stringify({ decision }) });
      if (result.revision) { setRevision(result.revision.revision); setTimeline(result.revision.timeline); }
      setProposal({ ...proposal, status: decision });
      setStatus("Proposal " + decision);
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function submitRender() {
    if (!projectId || !revision) { setStatus("Save a revision before rendering"); return; }
    setBusy(true);
    try {
      const result = await request("/v1/projects/" + projectId + "/renders", {
        method: "POST",
        body: JSON.stringify({
          revision,
          idempotencyKey: projectId + ":" + revision + ":preview",
          settings: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 },
        }),
      });
      setRenderJobId(result.job.id); setRenderUrl(""); setRenderJobStatus("queued 0%"); setStatus("Render queued: " + result.job.id); void pollRender(result.job.id);
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  return <div className="app-shell">
    <header className="topbar">
      <div><span className="eyebrow">AI VIDEO WORKSPACE</span><h1>VideoCraft</h1></div>
      <div className="status-pill" role="status" aria-live="polite"><span className="status-dot" />{status}</div>
    </header>
    <main className="workspace">
      <aside className="sidebar">
        <section className="panel">
          <h2>Project</h2>
          <label>API token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Bearer token" /></label>
          <label>Project name<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
          <button onClick={createProject} disabled={busy}>{projectId ? "Project " + projectId.slice(0, 8) : "Create project"}</button>
        </section>
        <section className="panel">
          <h2>Tailoring brief</h2>
          <label>Intent<textarea value={intent} onChange={(event) => setIntent(event.target.value)} /></label>
          <label>Audience<input value={audience} onChange={(event) => setAudience(event.target.value)} /></label>
          <label>Channel<input value={channel} onChange={(event) => setChannel(event.target.value)} /></label>
          <button className="secondary" onClick={analyzeBrief} disabled={busy || !projectId}>Analyze brief</button>
          <button className="secondary" onClick={previewProposal} disabled={busy || !revision}>Preview AI proposal</button>
        </section>
        <section className="panel">
          <h2>Asset reference</h2>
          <p className="muted">Upload and signed storage are handled by the API boundary. Paste a registered asset ID to place it on the timeline.</p>
          <input value={assetId} onChange={(event) => setAssetId(event.target.value)} placeholder="asset ID" />
          <button className="secondary" onClick={addClip}>Add video clip</button>
        </section>
      </aside>
      <section className="editor">
        <div className="editor-toolbar"><div><span className="eyebrow">TIMELINE</span><h2>{projectId ? "Revision " + revision : "No project selected"}</h2></div><div className="toolbar-actions"><button className="secondary" onClick={saveRevision} disabled={busy || !projectId}>Save revision</button><button onClick={submitRender} disabled={busy || !revision}>Render preview</button></div></div>
        <div className="timeline-card">
          <div className="ruler"><span>00:00</span><span>00:10</span><span>00:20</span><span>00:30</span></div>
          <div className="track-list">
            {timeline.tracks.length === 0 && <div className="empty-state">Your non-destructive timeline is empty. Add a registered asset to begin.</div>}
            {timeline.tracks.map((track) => <div className="track" key={track.id}><div className="track-label">{track.kind}</div><div className="track-lane">{track.clips.map((clip) => <button type="button" className={"clip" + (selectedClipId === clip.id ? " selected" : "")} key={clip.id} style={{ width: Math.max(16, ((clip.timelineEndUs - clip.timelineStartUs) / timeline.durationUs) * 100) + "%" }} aria-label={"Clip " + clip.assetId.slice(0, 12) + ", " + formatSeconds(clip.sourceEndUs - clip.sourceStartUs)} aria-pressed={selectedClipId === clip.id} onClick={() => setSelectedClipId(clip.id)} onKeyDown={(event) => handleClipKeyDown(event, clip)}><strong>{clip.assetId.slice(0, 12)}</strong><small>{formatSeconds(clip.sourceEndUs - clip.sourceStartUs)}</small></button>)}</div></div>)}
          </div>
        </div>
        <div className="lower-grid">
          <section className="panel preview-panel"><div className="panel-heading"><h2>Preview</h2><span className="badge">Non-destructive</span></div><div className="preview-screen">{renderUrl ? <video controls src={renderUrl} /> : <span>{renderJobId ? "Render " + renderJobStatus : "Playback preview connects to the selected revision"}</span>}</div></section>
          <section className="panel proposal-panel"><div className="panel-heading"><h2>AI proposal</h2>{proposal && <span className="badge">{Math.round(proposal.confidence * 100)}% confidence</span>}</div>{proposal ? <><p>{proposal.rationale}</p><div className="evidence">{proposal.evidence.map((item) => <div key={item.reference}><span>{item.source}</span><code>{item.reference}</code>{item.excerpt && <p>{item.excerpt}</p>}</div>)}</div>{proposal.status === "proposed" && <div className="decision-actions"><button className="secondary" onClick={() => decideProposal("rejected")} disabled={busy}>Reject</button><button onClick={() => decideProposal("accepted")} disabled={busy}>Accept as revision</button></div>}</> : <p className="muted">Save a revision to request an explainable tailoring proposal.</p>}</section>
        </div>
      </section>
    </main>
  </div>;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Something went wrong"; }
function formatSeconds(microseconds: number): string { return (microseconds / 1_000_000).toFixed(1) + "s"; }
