import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

type TimelineClip = {
  id: string;
  assetId: string;
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs: number;
  timelineEndUs: number;
  reason?: string;
  score?: number;
  transform?: Record<string, string | number | boolean>;
};
type Timeline = { durationUs: number; tracks: Array<{ id: string; kind: string; clips: TimelineClip[] }> };
type Evidence = { source: string; reference: string; excerpt?: string; startUs?: number; endUs?: number };
type Operation = { type: string; reason?: string; score?: number; sourceStartUs?: number; sourceEndUs?: number; [key: string]: unknown };
type Proposal = { id: string; rationale: string; confidence: number; evidence: Evidence[]; operations: Operation[]; status: string };
const PLATFORMS: Record<string, { label: string; width: number; height: number; fit: "cover" | "contain"; captionStyle: string }> = {
  tiktok: { label: "TikTok / Reels / Shorts 9:16", width: 1080, height: 1920, fit: "cover", captionStyle: "bold-pop" },
  youtube: { label: "YouTube 16:9", width: 1920, height: 1080, fit: "contain", captionStyle: "clean" },
  square: { label: "Feed 1:1", width: 1080, height: 1080, fit: "cover", captionStyle: "clean" },
  preview: { label: "Quick preview 720p", width: 1280, height: 720, fit: "contain", captionStyle: "clean" },
};
type Project = { id: string; name: string; revision: number; createdAt: string; updatedAt: string };
type Asset = { id: string; kind: string; storageKey: string; durationUs?: number; metadata: Record<string, string | number | boolean> };

const API = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";

export function App() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [userEmail, setUserEmail] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("My first cut");
  const [projects, setProjects] = useState<Project[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
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
  const [targetSeconds, setTargetSeconds] = useState(30);
  const [platform, setPlatform] = useState("tiktok");
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, string>>({});
  const [segmentStart, setSegmentStart] = useState("0");
  const [segmentEnd, setSegmentEnd] = useState("10");
  const [previewMode, setPreviewMode] = useState<"source" | "render">("source");
  const [sourceUrls, setSourceUrls] = useState<Record<string, string>>({});
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [sourceNote, setSourceNote] = useState("");

  const videoTrack = useMemo(() => timeline.tracks.find((track) => track.kind === "video"), [timeline]);
  const videoClips = useMemo(() => [...(videoTrack?.clips ?? [])].sort((a, b) => a.timelineStartUs - b.timelineStartUs), [videoTrack]);
  const captionCues = useMemo(() => timeline.tracks.filter((track) => track.kind === "caption").flatMap((track) => track.clips).sort((a, b) => a.timelineStartUs - b.timelineStartUs), [timeline]);
  const selectedClip = videoClips.find((clip) => clip.id === selectedClipId);
  const sourceAssetId = selectedClip?.assetId ?? videoClips[0]?.assetId ?? "";
  const sourceUrl = sourceUrls[sourceAssetId] ?? "";

  // Signed playback URLs for the original upload; fetched once per asset (they last an hour).
  useEffect(() => {
    if (!token || !projectId || !sourceAssetId || sourceUrls[sourceAssetId]) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    request("/v1/projects/" + projectId + "/assets/" + sourceAssetId + "/playback-url")
      .then((result) => {
        if (cancelled) return;
        // Formats browsers cannot play get a preview proxy; it is generated after upload.
        if (result.pending) { setSourceNote("Preparing a browser preview of this video…"); timer = setTimeout(() => setSourceRetry((n) => n + 1), (result.retryAfterSeconds ?? 5) * 1000); return; }
        setSourceNote(result.proxy ? "Previewing a 720p proxy; exports use the original" : "");
        setSourceUrls((current) => ({ ...current, [sourceAssetId]: /^https?:\/\//.test(result.url) ? result.url : API + result.url }));
      })
      .catch(() => undefined);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [token, projectId, sourceAssetId, sourceUrls, sourceRetry]);

  // Selecting a clip cues the player to the start of that clip's source range.
  useEffect(() => {
    const player = playerRef.current;
    if (player && selectedClip && sourceUrl && previewMode === "source") player.currentTime = selectedClip.sourceStartUs / 1_000_000;
  }, [selectedClipId, sourceUrl, previewMode]);

  function playSelectedClip() {
    const player = playerRef.current;
    if (!player || !selectedClip) { setStatus("Select a clip to play it"); return; }
    player.currentTime = selectedClip.sourceStartUs / 1_000_000;
    void player.play().catch(() => undefined);
  }
  function stopAtClipEnd() {
    const player = playerRef.current;
    if (player && selectedClip && !player.paused && player.currentTime * 1_000_000 >= selectedClip.sourceEndUs) player.pause();
  }
  function trimToPlayhead(edge: "start" | "end") {
    const player = playerRef.current;
    if (!player || !selectedClip) { setStatus("Select a clip first"); return; }
    const at = Math.round(player.currentTime * 1_000_000);
    if (edge === "start") trimSelectedClip(at - selectedClip.sourceStartUs, 0); else trimSelectedClip(0, at - selectedClip.sourceEndUs);
  }
  function markSegmentFromPlayhead(edge: "start" | "end") {
    const player = playerRef.current;
    if (!player) return;
    (edge === "start" ? setSegmentStart : setSegmentEnd)(player.currentTime.toFixed(2));
  }

  async function request(path: string, init: RequestInit = {}, accessToken = token, retried = false): Promise<any> {
    const response = await fetch(API + path, {
      ...init,
      credentials: "include",
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(accessToken ? { authorization: "Bearer " + accessToken } : {}), ...init.headers },
    });
    if (response.status === 401 && accessToken && !retried && !path.startsWith("/auth/")) {
      // The 15-minute access token expired: rotate the refresh session once and retry.
      const refreshed = await fetch(API + "/auth/refresh", { method: "POST", credentials: "include" });
      if (refreshed.ok) { const session = await refreshed.json(); setToken(session.accessToken); return request(path, init, session.accessToken, true); }
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message ?? "Request failed");
    return body;
  }

  async function authenticate() {
    setBusy(true);
    try {
      const result = await request(authMode === "login" ? "/auth/login" : "/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
      setToken(result.accessToken);
      setUserEmail(result.user.email);
      setPassword("");
      setStatus(authMode === "login" ? "Signed in" : "Account created");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function restoreSession() {
    try {
      const result = await request("/auth/refresh", { method: "POST" });
      setToken(result.accessToken);
      setUserEmail(result.user.email);
    } catch { /* A first visit has no refresh session. */ }
  }

  useEffect(() => { if (!token) void restoreSession(); }, []);

  async function signOut() {
    await request("/auth/logout", { method: "POST" }).catch(() => undefined);
    setToken("");
    setUserEmail("");
    setProjects([]);
    setProjectId("");
    setStatus("Signed out");
  }

  async function createProject() {
    setBusy(true);
    try {
      const result = await request("/v1/projects", { method: "POST", body: JSON.stringify({ name: projectName }) });
      setProjectId(result.project.id);
      setProjects((current) => [...current.filter((project) => project.id !== result.project.id), result.project]);
      setStatus("Project created");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function refreshProjects() {
    if (!token) { setStatus("Enter an API token first"); return; }
    setBusy(true);
    try {
      const result = await request("/v1/projects");
      setProjects(result.projects);
      setStatus(result.projects.length ? "Projects refreshed" : "No projects found");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function openProject(project: Project) {
    setBusy(true);
    try {
      setProjectId(project.id);
      setProjectName(project.name);
      setRevision(project.revision);
      setProposal(null);
      setRenderJobId("");
      setRenderJobStatus("");
      setRenderUrl("");
      const [assetResult, revisionResult] = await Promise.all([
        request("/v1/projects/" + project.id + "/assets"),
        project.revision > 0 ? request("/v1/projects/" + project.id + "/revisions/" + project.revision) : Promise.resolve(null),
      ]);
      setAssets(assetResult.assets);
      if (revisionResult) {
        setTimeline(revisionResult.revision.timeline);
      } else {
        setTimeline({ durationUs: 30_000_000, tracks: [] });
      }
      setStatus("Opened " + project.name);
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function uploadAsset(event: { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget; // React clears currentTarget once the handler yields
    const file = input.files?.[0];
    if (!file || !projectId) { setStatus(projectId ? "Choose a media file first" : "Create a project first"); return; }
    setBusy(true);
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch(API + "/v1/projects/" + projectId + "/assets/upload?kind=" + encodeURIComponent(uploadKind), { method: "POST", body: form, headers: token ? { authorization: "Bearer " + token } : {} });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message ?? "Upload failed");
      setAssets((current) => [...current.filter((asset) => asset.id !== body.asset.id), body.asset]);
      setAssetId(body.asset.id); setStatus("Uploaded asset " + body.asset.id.slice(0, 8));
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); input.value = ""; }
  }

  async function pollRender(id: string) {
    // Renders of long videos take minutes: poll for up to 20 minutes, easing off after the first minute.
    const started = Date.now();
    while (Date.now() - started < 20 * 60_000) {
      await new Promise((resolve) => setTimeout(resolve, Date.now() - started < 60_000 ? 2000 : 5000));
      try {
        const result = await request("/v1/projects/" + projectId + "/renders/" + id);
        setRenderJobStatus(result.job.status + " " + result.job.progress + "%");
        if (result.job.status === "succeeded") { const download = await request("/v1/projects/" + projectId + "/renders/" + id + "/download-url"); setRenderUrl(/^https?:\/\//.test(download.url) ? download.url : API + download.url); setStatus("Render succeeded"); setPreviewMode("render"); return; }
        if (["failed", "cancelled"].includes(result.job.status)) { setStatus("Render " + result.job.status + (result.job.errorMessage ? ": " + String(result.job.errorMessage).slice(0, 200) : "")); return; }
      } catch (error) { setStatus(errorMessage(error)); return; }
    }
    setStatus("Render is still running; check back in a moment");
  }

  function addClip() {
    if (!assetId.trim()) { setStatus("Register an asset and enter its asset ID first"); return; }
    const videoEndUs = videoClips.reduce((end, existing) => Math.max(end, existing.timelineEndUs), 0);
    const knownAsset = assets.find((asset) => asset.id === assetId.trim());
    const assetLengthUs = knownAsset?.durationUs && knownAsset.durationUs > 0 ? knownAsset.durationUs : 10_000_000;
    const clip: TimelineClip = {
      id: "clip-" + Date.now(),
      assetId: assetId.trim(),
      sourceStartUs: 0,
      sourceEndUs: assetLengthUs,
      timelineStartUs: videoEndUs,
      timelineEndUs: videoEndUs + assetLengthUs,
    };
    setSelectedClipId(clip.id);
    setTimeline((current) => ({
      ...current,
      durationUs: Math.max(current.durationUs, videoEndUs + assetLengthUs),
      tracks: current.tracks.some((track) => track.kind === "video")
        ? current.tracks.map((track) => track.kind === "video" ? { ...track, clips: [...track.clips, clip] } : track)
        : [...current.tracks, { id: "video-1", kind: "video", clips: [clip] }],
    }));
    setStatus("Clip added to the non-destructive timeline");
  }

  /** Saved revisions are edited on the server (ripple edit, captions follow the cuts); unsaved drafts edit locally. */
  async function applyEdit(operations: Array<Record<string, unknown>>, message: string) {
    if (!projectId || !revision) return false;
    setBusy(true);
    try {
      const result = await request("/v1/projects/" + projectId + "/revisions/" + revision + "/edit", { method: "POST", body: JSON.stringify({ operations }) });
      setRevision(result.revision.revision);
      setTimeline(result.revision.timeline);
      setRenderUrl(""); setRenderJobId(""); setRenderJobStatus("");
      setStatus(message + " (revision " + result.revision.revision + ")");
      return true;
    } catch (error) { setStatus(errorMessage(error)); return false; }
    finally { setBusy(false); }
  }

  function nudgeSelectedClip(direction: -1 | 1, clipId = selectedClipId) {
    if (!clipId) { setStatus("Select a clip first"); return; }
    const message = direction < 0 ? "Clip moved earlier" : "Clip moved later";
    if (revision > 0) {
      const index = videoClips.findIndex((clip) => clip.id === clipId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= videoClips.length) { setStatus("Clip is already at the " + (direction < 0 ? "start" : "end")); return; }
      const order = videoClips.map((clip) => clip.id);
      [order[index], order[target]] = [order[target] as string, order[index] as string];
      void applyEdit([{ type: "reorder-clips", clipIds: order }], message);
      return;
    }
    setTimeline((current) => ({
      ...current,
      tracks: current.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip;
          const duration = clip.timelineEndUs - clip.timelineStartUs;
          const nextStart = Math.max(0, Math.min(current.durationUs - duration, clip.timelineStartUs + direction * 500_000));
          return { ...clip, timelineStartUs: nextStart, timelineEndUs: nextStart + duration };
        }),
      })),
    }));
    setStatus(message);
  }

  function removeSelectedClip(clipId = selectedClipId) {
    if (!clipId) { setStatus("Select a clip first"); return; }
    setSelectedClipId("");
    if (revision > 0) { void applyEdit([{ type: "remove-clip", clipId, reason: "Removed in the editor" }], "Clip removed"); return; }
    setTimeline((current) => ({ ...current, tracks: current.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== clipId) })).filter((track) => track.clips.length > 0) }));
    setStatus("Clip removed from the non-destructive timeline");
  }

  function trimSelectedClip(startDeltaUs: number, endDeltaUs: number) {
    if (!selectedClip) { setStatus("Select a clip first"); return; }
    if (revision === 0) { setStatus("Save a revision before trimming"); return; }
    const source = assets.find((asset) => asset.id === selectedClip.assetId);
    const start = Math.max(0, selectedClip.sourceStartUs + startDeltaUs);
    const end = Math.min(source?.durationUs ?? Number.MAX_SAFE_INTEGER, selectedClip.sourceEndUs + endDeltaUs);
    if (end - start < 300_000) { setStatus("A clip must stay at least 0.3s long"); return; }
    void applyEdit([{ type: "trim-clip", clipId: selectedClip.id, sourceStartUs: start, sourceEndUs: end }], "Clip trimmed");
  }

  function addSegment() {
    const start = Number(segmentStart);
    const end = Number(segmentEnd);
    const source = assets.find((asset) => asset.id === (selectedClip?.assetId ?? assetId));
    if (!source) { setStatus("Choose the source asset first"); return; }
    if (!(start >= 0) || !(end > start)) { setStatus("Enter a start and end in seconds (end after start)"); return; }
    if (source.durationUs && end * 1_000_000 > source.durationUs) { setStatus("The segment ends after the source video does"); return; }
    if (revision === 0) { setStatus("Save a revision before adding segments"); return; }
    void applyEdit([{ type: "insert-clip", assetId: source.id, sourceStartUs: Math.round(start * 1e6), sourceEndUs: Math.round(end * 1e6), reason: "Added in the editor" }], "Segment added");
  }

  function saveCaption(clip: TimelineClip) {
    const text = (captionDrafts[clip.id] ?? String(clip.transform?.text ?? "")).trim();
    if (!text) { setStatus("A caption cannot be empty"); return; }
    void applyEdit([{ type: "update-caption", clipId: clip.id, text }], "Caption corrected").then((ok) => { if (ok) setCaptionDrafts((current) => { const { [clip.id]: _removed, ...rest } = current; return rest; }); });
  }

  function handleClipKeyDown(event: KeyboardEvent<HTMLButtonElement>, clip: TimelineClip) {
    if (event.key === "ArrowLeft") { event.preventDefault(); setSelectedClipId(clip.id); nudgeSelectedClip(-1, clip.id); }
    if (event.key === "ArrowRight") { event.preventDefault(); setSelectedClipId(clip.id); nudgeSelectedClip(1, clip.id); }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); setSelectedClipId(clip.id); removeSelectedClip(clip.id); }
  }

  async function transcribeAsset() {
    if (!projectId || !assetId) { setStatus("Choose an uploaded video first"); return; }
    setBusy(true);
    setStatus("Transcribing… this can take a few minutes for long videos");
    try {
      const result = await request("/v1/projects/" + projectId + "/assets/" + assetId + "/transcript", { method: "POST" });
      const words = result.segments.reduce((total: number, segment: { words: unknown[] }) => total + segment.words.length, 0);
      setStatus("Transcribed " + result.segments.length + " segments (" + words + " timed words)");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
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
        body: JSON.stringify({ revision, strategyId: "highlight-reel", profile: { intent, audience, channel, targetDurationUs: Math.round(targetSeconds * 1_000_000), constraints: [] } }),
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
          idempotencyKey: projectId + ":" + revision + ":" + platform,
          settings: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: PLATFORMS[platform]!.width, height: PLATFORMS[platform]!.height, frameRate: 30, fit: PLATFORMS[platform]!.fit, captionStyle: PLATFORMS[platform]!.captionStyle },
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
          {userEmail ? <div className="auth-session"><span>Signed in as {userEmail}</span><button className="secondary" onClick={signOut} disabled={busy}>Sign out</button></div> : <><div className="auth-tabs"><button className={authMode === "login" ? "" : "secondary"} onClick={() => setAuthMode("login")}>Sign in</button><button className={authMode === "register" ? "" : "secondary"} onClick={() => setAuthMode("register")}>Create account</button></div><label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} /></label><button onClick={authenticate} disabled={busy || !email || password.length < 10}>{authMode === "login" ? "Sign in" : "Create account"}</button></>}
          <label>Project name<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
          <button onClick={createProject} disabled={busy}>{projectId ? "Project " + projectId.slice(0, 8) : "Create project"}</button>
          <button className="secondary" onClick={refreshProjects} disabled={busy || !token}>Refresh projects</button>
          {projects.length > 0 && <label>Existing project<select value={projectId} onChange={(event) => { const project = projects.find((item) => item.id === event.target.value); if (project) void openProject(project); }}><option value="">Choose a project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · rev {project.revision}</option>)}</select></label>}
        </section>
        <section className="panel">
          <h2>Tailoring brief</h2>
          <label>Intent<textarea value={intent} onChange={(event) => setIntent(event.target.value)} /></label>
          <label>Audience<input value={audience} onChange={(event) => setAudience(event.target.value)} /></label>
          <label>Channel<input value={channel} onChange={(event) => setChannel(event.target.value)} /></label>
          <button className="secondary" onClick={analyzeBrief} disabled={busy || !projectId}>Analyze brief</button>
          <label>Target length (seconds)<input type="number" min={5} max={600} value={targetSeconds} onChange={(event) => setTargetSeconds(Math.max(5, Number(event.target.value) || 30))} /></label>
          <button className="secondary" onClick={previewProposal} disabled={busy || !revision}>Find highlights</button>
        </section>
        <section className="panel">
          <h2>Asset reference</h2>
          <p className="muted">Upload media, choose it from the project library, then place a non-destructive clip on the timeline.</p>
          <label>Upload media<select value={uploadKind} onChange={(event) => setUploadKind(event.target.value)}><option value="video">Video</option><option value="audio">Audio</option><option value="image">Image</option><option value="caption">Caption</option></select><input type="file" accept="video/*,audio/*,image/*" onChange={uploadAsset} disabled={busy || !projectId} /></label>
          <label>Project library<select value={assetId} onChange={(event) => setAssetId(event.target.value)}><option value="">Choose an asset</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.kind} · {String(asset.metadata.filename ?? asset.id.slice(0, 8))}</option>)}</select></label>
          <label>Registered asset ID<input value={assetId} onChange={(event) => setAssetId(event.target.value)} placeholder="asset ID" /></label>
          <button className="secondary" onClick={addClip} disabled={!assetId}>Add video clip</button>
          <button className="secondary" onClick={transcribeAsset} disabled={busy || !projectId || !assetId}>Transcribe</button>
        </section>
      </aside>
      <section className="editor">
        <div className="editor-toolbar"><div><span className="eyebrow">TIMELINE</span><h2>{projectId ? "Revision " + revision : "No project selected"}</h2></div><div className="toolbar-actions"><button className="secondary" onClick={saveRevision} disabled={busy || !projectId}>Save revision</button><select aria-label="Platform" value={platform} onChange={(event) => setPlatform(event.target.value)}>{Object.entries(PLATFORMS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}</select><button onClick={submitRender} disabled={busy || !revision}>Render preview</button></div></div>
        <div className="timeline-card">
          <div className="ruler"><span>00:00</span><span>00:10</span><span>00:20</span><span>00:30</span></div>
          <div className="track-list">
            {timeline.tracks.length === 0 && <div className="empty-state">Your non-destructive timeline is empty. Add a registered asset to begin.</div>}
            {timeline.tracks.map((track) => <div className="track" key={track.id}><div className="track-label">{track.kind}</div><div className="track-lane">{track.clips.map((clip) => <button type="button" className={"clip" + (selectedClipId === clip.id ? " selected" : "")} key={clip.id} style={{ width: Math.max(16, ((clip.timelineEndUs - clip.timelineStartUs) / timeline.durationUs) * 100) + "%" }} aria-label={"Clip " + clip.assetId.slice(0, 12) + ", " + formatSeconds(clip.sourceEndUs - clip.sourceStartUs)} aria-pressed={selectedClipId === clip.id} onClick={() => setSelectedClipId(clip.id)} onKeyDown={(event) => handleClipKeyDown(event, clip)}><strong>{clip.assetId.slice(0, 12)}</strong><small>{formatSeconds(clip.sourceEndUs - clip.sourceStartUs)}</small></button>)}</div></div>)}
          </div>
        </div>
        {selectedClip && <section className="panel clip-panel" aria-label="Selected clip">
          <div className="panel-heading"><h2>Selected clip</h2><span className="badge">{formatSeconds(selectedClip.sourceStartUs)}–{formatSeconds(selectedClip.sourceEndUs)} of source</span></div>
          {selectedClip.reason && <p>{selectedClip.reason}{typeof selectedClip.score === "number" && <> <span className="badge">score {Math.round(selectedClip.score * 100)}</span></>}</p>}
          <div className="clip-actions">
            <button className="secondary" onClick={() => nudgeSelectedClip(-1)} disabled={busy}>Move earlier</button>
            <button className="secondary" onClick={() => nudgeSelectedClip(1)} disabled={busy}>Move later</button>
            <button className="secondary" onClick={() => trimSelectedClip(500_000, 0)} disabled={busy || revision === 0}>Trim start +0.5s</button>
            <button className="secondary" onClick={() => trimSelectedClip(-500_000, 0)} disabled={busy || revision === 0}>Start −0.5s</button>
            <button className="secondary" onClick={() => trimSelectedClip(0, -500_000)} disabled={busy || revision === 0}>Trim end −0.5s</button>
            <button className="secondary" onClick={() => trimSelectedClip(0, 500_000)} disabled={busy || revision === 0}>End +0.5s</button>
            <button className="secondary" onClick={() => removeSelectedClip()} disabled={busy}>Remove</button>
          </div>
        </section>}
        {revision > 0 && <section className="panel segment-panel" aria-label="Add segment">
          <h2>Add a segment</h2>
          <div className="segment-row"><label>Start (s)<input type="number" min={0} step={0.1} value={segmentStart} onChange={(event) => setSegmentStart(event.target.value)} /></label><label>End (s)<input type="number" min={0} step={0.1} value={segmentEnd} onChange={(event) => setSegmentEnd(event.target.value)} /></label><button className="secondary" onClick={addSegment} disabled={busy}>Add segment</button></div>
        </section>}
        {captionCues.length > 0 && <section className="panel captions-panel" aria-label="Captions">
          <div className="panel-heading"><h2>Captions</h2><span className="badge">{captionCues.length} cues</span></div>
          <p className="muted">Captions follow their clips when you cut or reorder. Correct wording here; timing is kept.</p>
          <ul className="cue-list">{captionCues.map((cue) => { const original = String(cue.transform?.text ?? ""); const draft = captionDrafts[cue.id] ?? original; return <li key={cue.id}><span className="cue-time">{formatSeconds(cue.timelineStartUs)}</span><input aria-label={"Caption at " + formatSeconds(cue.timelineStartUs)} value={draft} onChange={(event) => setCaptionDrafts((current) => ({ ...current, [cue.id]: event.target.value }))} /><button className="secondary" onClick={() => saveCaption(cue)} disabled={busy || revision === 0 || draft.trim() === original}>Save</button></li>; })}</ul>
        </section>}
        <div className="lower-grid">
          <section className="panel preview-panel"><div className="panel-heading"><h2>Preview</h2><span className="badge">Non-destructive</span></div><div className="preview-tabs" role="tablist"><button role="tab" aria-selected={previewMode === "source"} className={previewMode === "source" ? "" : "secondary"} onClick={() => setPreviewMode("source")}>Source</button><button role="tab" aria-selected={previewMode === "render"} className={previewMode === "render" ? "" : "secondary"} onClick={() => setPreviewMode("render")}>Rendered export</button></div><div className="preview-screen">{previewMode === "render" ? (renderUrl ? <video controls src={renderUrl} /> : <span>{renderJobId ? "Render " + renderJobStatus : "Render a platform export to preview it here"}</span>) : (sourceUrl ? <video ref={playerRef} controls src={sourceUrl} onTimeUpdate={stopAtClipEnd} /> : <span>{sourceNote || "Sign in and add a video to scrub the source here"}</span>)}</div>{previewMode === "source" && sourceUrl && sourceNote && <p className="muted">{sourceNote}</p>}{previewMode === "source" && sourceUrl && <div className="player-actions"><button className="secondary" onClick={playSelectedClip} disabled={!selectedClip}>Play selected clip</button><button className="secondary" onClick={() => trimToPlayhead("start")} disabled={busy || !selectedClip || revision === 0}>Trim start to playhead</button><button className="secondary" onClick={() => trimToPlayhead("end")} disabled={busy || !selectedClip || revision === 0}>Trim end to playhead</button><button className="secondary" onClick={() => markSegmentFromPlayhead("start")}>Segment start = playhead</button><button className="secondary" onClick={() => markSegmentFromPlayhead("end")}>Segment end = playhead</button></div>}</section>
          <section className="panel proposal-panel"><div className="panel-heading"><h2>AI proposal</h2>{proposal && <span className="badge">{Math.round(proposal.confidence * 100)}% confidence</span>}</div>{proposal ? <><p>{proposal.rationale}</p>{proposal.operations.some((operation) => operation.type === "insert-clip") && <ol className="highlight-list">{proposal.operations.filter((operation) => operation.type === "insert-clip").map((operation, index) => <li key={index}><strong>{formatSeconds(operation.sourceStartUs ?? 0)}–{formatSeconds(operation.sourceEndUs ?? 0)}</strong>{typeof operation.score === "number" && <span className="badge">score {Math.round(operation.score * 100)}</span>}<p>{operation.reason}</p></li>)}</ol>}<div className="evidence">{proposal.evidence.map((item) => <div key={item.reference}><span>{item.source}</span><code>{item.reference}{typeof item.startUs === "number" && typeof item.endUs === "number" ? " · " + formatSeconds(item.startUs) + "–" + formatSeconds(item.endUs) : ""}</code>{item.excerpt && <p>{item.excerpt}</p>}</div>)}</div>{proposal.status === "proposed" && <div className="decision-actions"><button className="secondary" onClick={() => decideProposal("rejected")} disabled={busy}>Reject</button><button onClick={() => decideProposal("accepted")} disabled={busy}>Accept as revision</button></div>}</> : <p className="muted">Save a revision to request an explainable tailoring proposal.</p>}</section>
        </div>
      </section>
    </main>
  </div>;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Something went wrong"; }
function formatSeconds(microseconds: number): string { return (microseconds / 1_000_000).toFixed(1) + "s"; }
