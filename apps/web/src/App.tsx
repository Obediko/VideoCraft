import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { LivePreview, type LivePreviewHandle } from "./LivePreview.js";
import { StockSearch } from "./StockSearch.js";
import { VoiceOver } from "./VoiceOver.js";
import { Level } from "./Level.js";
import type { FaceTrack } from "./preview.js";
import { cueOps, keptWords, rangeForWords, removeRangeOps, restoreRangeOps, secondsFromBrief, sourceToTimeline, timelineToSource, type Word } from "./story.js";

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
const PLATFORMS: Record<string, { label: string; short: string; width: number; height: number; fit: "cover" | "contain"; captionStyle: string }> = {
  tiktok: { label: "Reel / Short / TikTok · 9:16", short: "Short 9:16", width: 1080, height: 1920, fit: "cover", captionStyle: "bold-pop" },
  youtube: { label: "YouTube · 16:9", short: "YouTube 16:9", width: 1920, height: 1080, fit: "contain", captionStyle: "clean" },
  square: { label: "Feed · 1:1", short: "Feed 1:1", width: 1080, height: 1080, fit: "cover", captionStyle: "clean" },
  preview: { label: "Quick preview · 720p", short: "Preview 720p", width: 1280, height: 720, fit: "contain", captionStyle: "clean" },
};
type Suggestion = { id: string; kind: string; title: string; reason: string; text?: string; subtitle?: string; atS?: number; durationS?: number; segments?: Array<{ startS: number; endS: number }>; mood?: string; platform?: string; assetId?: string; mode?: string; changeDb?: number; target?: string; query?: string; color?: string; pick?: { provider: string; id: string; thumbUrl: string; credit?: string } };
type DirectorPlan = { summary: string; profile: { intent: string; audience: string; channel: string; tone: string; targetSeconds: number }; suggestions: Suggestion[]; source: "ai" | "rules"; model?: string; note?: string };
const PLAN_GROUPS: Array<{ name: string; kinds: string[] }> = [
  { name: "Story", kinds: ["cut"] },
  { name: "Text on screen", kinds: ["title", "callout", "lower-third", "progress", "captions", "color"] },
  { name: "Cutaways", kinds: ["broll", "stock"] },
  { name: "Look", kinds: ["look", "background", "zooms"] },
  { name: "Sound", kinds: ["music", "sfx", "volume", "voiceover"] },
  { name: "Taking out", kinds: ["remove"] },
  { name: "Pacing", kinds: ["transitions"] },
  { name: "Format", kinds: ["platform"] },
  { name: "Tips from the director", kinds: ["advice"] },
];
const LOOK_LABEL: Record<string, string> = { none: "Natural (no look)", warm: "Warm", clean: "Clean & crisp", cinematic: "Cinematic", vivid: "Vivid", soft: "Soft", mono: "Black & white" };
const ZOOM_LABEL: Record<string, string> = { none: "No zoom", punch: "Punch in (tighter framing)", push: "Slow push-in" };
const TRANSITION_LABEL: Record<string, string> = { cut: "Cut", dissolve: "Dissolve", push: "Push", "slide-up": "Slide up", wipe: "Wipe", circle: "Circle reveal", blur: "Blur", "dip-black": "Dip to black", "dip-white": "Dip to white", flash: "Flash" };
const ENDING_LABEL: Record<string, string> = { cut: "Cut", "dip-black": "Fade to black", "dip-white": "Fade to white", flash: "Flash" };
const SFX_LABEL: Record<string, string> = { whoosh: "Whoosh", pop: "Pop", hit: "Boom", riser: "Riser" };
const MODES = [
  { id: "story", label: "Story" }, { id: "captions", label: "Captions" }, { id: "visuals", label: "Visuals" },
  { id: "audio", label: "Audio" }, { id: "brand", label: "Brand" }, { id: "review", label: "Review" },
] as const;
type Mode = (typeof MODES)[number]["id"];
type Screen = "projects" | "describe" | "plan" | "edit" | "check" | "export";
/** Ruler ticks every 1/2/5/10/15/30/60 s so that there are about 6–12 of them. */
function rulerTicks(durationUs: number): number[] {
  const total = Math.max(1, durationUs / 1e6);
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => total / s <= 12) ?? 600;
  const ticks: number[] = []; for (let t = 0; t <= total + 1e-6; t += step) ticks.push(t);
  return ticks;
}
type CheckIssue = { id: string; severity: "fix" | "warn" | "info"; kind: string; title: string; detail: string; atS?: number; fix?: { label: string; operations: Array<Record<string, unknown>> }; source: "rules" | "ai" };
type CheckResult = { issues: CheckIssue[]; ai: boolean; scanned: boolean; note?: string; revision: number };
type Project = { id: string; name: string; revision: number; createdAt: string; updatedAt: string };
type Asset = { id: string; kind: string; storageKey: string; durationUs?: number; metadata: Record<string, string | number | boolean> };
type Segment = { id: string; startUs: number; endUs: number; text: string; words: Word[] };

const API = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";
const LAST_PROJECT_KEY = "videocraft.lastProject";
const LAST_SCREEN_KEY = "videocraft.lastScreen";
// One refresh at a time per tab: the server rotates the session on every refresh, so parallel refreshes would race.
let refreshInFlight: Promise<{ accessToken: string; user: { email: string } }> | null = null;
function refreshSession(): Promise<{ accessToken: string; user: { email: string } }> {
  refreshInFlight ??= fetch(API + "/auth/refresh", { method: "POST", credentials: "include" })
    .then(async (response) => { if (!response.ok) throw new Error("No session"); return response.json(); })
    .finally(() => { setTimeout(() => { refreshInFlight = null; }, 0); });
  return refreshInFlight;
}
function remember(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }
function recall(key: string): string { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } }
function kindOfFile(file: File): string { return file.type.startsWith("audio/") ? "audio" : file.type.startsWith("image/") ? "image" : "video"; }

export function App() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [userEmail, setUserEmail] = useState("");
  const [sessionChecked, setSessionChecked] = useState(false);
  const [screen, setScreenState] = useState<Screen>("projects");
  const [mode, setMode] = useState<Mode>("story");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [timeline, setTimeline] = useState<Timeline>({ durationUs: 0, tracks: [] });
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [renderJobId, setRenderJobId] = useState("");
  const [renderJobStatus, setRenderJobStatus] = useState("");
  const [renderUrl, setRenderUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState("");
  const [platform, setPlatform] = useState("tiktok");
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, string>>({});
  const [previewMode, setPreviewMode] = useState<"edit" | "source" | "render">("edit");
  const liveRef = useRef<LivePreviewHandle | null>(null);
  const recordAnchor = useRef<{ anchorAssetId: string; anchorSourceUs: number; where: string } | undefined>(undefined);
  const liveUsRef = useRef(0);
  const lastLiveReport = useRef(0);
  const [liveUs, setLiveUs] = useState(0);
  const [sourceUrls, setSourceUrls] = useState<Record<string, string>>({});
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [faceTracks, setFaceTracks] = useState<Record<string, FaceTrack>>({});
  const [faceRetry, setFaceRetry] = useState(0);
  const [matteUrls, setMatteUrls] = useState<Record<string, string>>({});
  const [matteRetry, setMatteRetry] = useState(0);
  const [musicVolume, setMusicVolume] = useState(-20);
  const [musicMood, setMusicMood] = useState("auto");
  const [musicDuck, setMusicDuck] = useState(true);
  const [learned, setLearned] = useState<{ samples: number; summary: string; counts: Record<string, number> } | null>(null);
  const [sourceNote, setSourceNote] = useState("");
  const [brief, setBrief] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [plan, setPlan] = useState<DirectorPlan | null>(null);
  const [planApplied, setPlanApplied] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [planText, setPlanText] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [fixPicked, setFixPicked] = useState<Record<string, boolean>>({});
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segmentsFor, setSegmentsFor] = useState("");
  const [transcribing, setTranscribing] = useState<{ assetId: string; promise: Promise<void> } | null>(null);
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
  const [newName, setNewName] = useState("");
  const [askText, setAskText] = useState("");
  const [askPlan, setAskPlan] = useState<DirectorPlan | null>(null);
  const [askPicked, setAskPicked] = useState<Record<string, boolean>>({});
  const setScreen = (next: Screen) => { setScreenState(next); remember(LAST_SCREEN_KEY, next); };

  const videoTrack = useMemo(() => timeline.tracks.find((track) => track.kind === "video"), [timeline]);
  const videoClips = useMemo(() => [...(videoTrack?.clips ?? [])].sort((a, b) => a.timelineStartUs - b.timelineStartUs), [videoTrack]);
  const captionCues = useMemo(() => timeline.tracks.filter((track) => track.kind === "caption").flatMap((track) => track.clips).sort((a, b) => a.timelineStartUs - b.timelineStartUs), [timeline]);
  const allClips = timeline.tracks.flatMap((track) => track.clips.map((clip) => ({ clip, kind: track.kind })));
  const selected = allClips.find((item) => item.clip.id === selectedClipId);
  const selectedClip = videoClips.find((clip) => clip.id === selectedClipId);
  const musicClip = timeline.tracks.find((track) => track.kind === "audio")?.clips.find((clip) => clip.transform?.role === "music");
  const musicName = musicClip ? String(assets.find((asset) => asset.id === musicClip.assetId)?.metadata.filename ?? "music") : "";
  const audioAssets = assets.filter((asset) => asset.kind === "audio" && !asset.metadata.voiceover && !String(asset.metadata.filename ?? "").startsWith("Voice-over "));
  const [musicAssetId, setMusicAssetId] = useState("");
  const [brollAssetId, setBrollAssetId] = useState("");
  const [brollSeconds, setBrollSeconds] = useState(3);
  const [brollMode, setBrollMode] = useState<"full" | "pip" | "behind">("full");
  const [bgKind, setBgKind] = useState<"none" | "blur" | "color" | "media">("blur");
  const [bgColor, setBgColor] = useState("#1F2A24");
  const [bgAssetId, setBgAssetId] = useState("");
  const [bgEdge, setBgEdge] = useState(0);
  const [bgFeather, setBgFeather] = useState(2);
  const brollAssets = assets.filter((asset) => asset.kind === "image" || (asset.kind === "video" && !videoClips.some((clip) => clip.assetId === asset.id)));
  const [gfxKind, setGfxKind] = useState<"title" | "callout" | "lower-third">("title");
  const [gfxText, setGfxText] = useState("");
  const [gfxSubtitle, setGfxSubtitle] = useState("");
  const [gfxSeconds, setGfxSeconds] = useState(3);
  const [gfxPosition, setGfxPosition] = useState<"top" | "center" | "bottom">("top");
  const [gfxColor, setGfxColor] = useState("#A8C49A");
  const [gfxDrafts, setGfxDrafts] = useState<Record<string, string>>({});
  const [sfxKind, setSfxKind] = useState("whoosh");
  const overlayClips = timeline.tracks.filter((track) => track.kind === "overlay").flatMap((track) => track.clips);
  const graphicsClips = overlayClips.filter((clip) => clip.transform?.role === "graphic");
  const progressClip = overlayClips.find((clip) => clip.transform?.role === "progress");
  const sfxClips = timeline.tracks.filter((track) => track.kind === "audio").flatMap((track) => track.clips).filter((clip) => clip.transform?.role === "sfx");
  const voiceovers = timeline.tracks.filter((track) => track.kind === "audio").flatMap((track) => track.clips).filter((clip) => clip.transform?.role === "voiceover");
  const looks = new Set(videoClips.map((clip) => String(clip.transform?.look ?? "none")));
  const wholeLook = looks.size === 1 ? [...looks][0]! : "mixed";
  const brolls = overlayClips.filter((clip) => clip.transform?.role === "broll");
  const mainVideo = assets.find((asset) => asset.id === videoClips[0]?.assetId && asset.kind === "video") ?? [...assets].reverse().find((asset) => asset.kind === "video");
  const sourceAssetId = selectedClip?.assetId ?? videoClips[0]?.assetId ?? mainVideo?.id ?? "";
  const sourceUrl = sourceUrls[sourceAssetId] ?? "";
  const words = useMemo(() => segments.flatMap((segment) => segment.words).sort((a, b) => a.startUs - b.startUs), [segments]);
  const kept = useMemo(() => (segmentsFor ? keptWords(words, videoClips, segmentsFor) : []), [words, videoClips, segmentsFor]);
  const keptUs = videoClips.reduce((sum, clip) => sum + clip.sourceEndUs - clip.sourceStartUs, 0);
  const currentProject = projects.find((project) => project.id === projectId);
  const hasVideo = assets.some((asset) => asset.kind === "video");
  const edited = revision > 0 && videoClips.length > 0;

  // Signed playback URLs for the footage, cutaways and music on the timeline; fetched once per asset (they last an hour).
  const backgroundAssets = videoClips.map((clip) => clip.transform?.backgroundAssetId).filter((id): id is string => typeof id === "string");
  const neededAssets = [...new Set([sourceAssetId, ...videoClips.map((clip) => clip.assetId), ...brolls.map((clip) => clip.assetId), ...backgroundAssets, ...voiceovers.map((clip) => clip.assetId), ...(musicClip ? [musicClip.assetId] : [])].filter((id) => id && !id.startsWith("generated:")))];
  useEffect(() => {
    const missing = neededAssets.filter((id) => !sourceUrls[id]);
    if (!token || !projectId || missing.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const id of missing) {
      request("/v1/projects/" + projectId + "/assets/" + id + "/playback-url")
        .then((result) => {
          if (cancelled) return;
          // Formats browsers cannot play get a preview proxy; it is generated after upload.
          if (result.pending) { if (id === sourceAssetId) setSourceNote("Preparing a browser preview of this video…"); timer = setTimeout(() => setSourceRetry((n) => n + 1), (result.retryAfterSeconds ?? 5) * 1000); return; }
          if (id === sourceAssetId) setSourceNote(result.proxy ? "Previewing a 720p copy; exports use the original" : "");
          setSourceUrls((current) => ({ ...current, [id]: /^https?:\/\//.test(result.url) ? result.url : API + result.url }));
        })
        .catch(() => undefined);
    }
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [token, projectId, neededAssets.join(","), sourceRetry]);

  // The speaker's face in each video on the timeline, so the live preview keeps captions and text off it.
  const faceAssets = [...new Set(videoClips.map((clip) => clip.assetId))].filter((id) => assets.some((asset) => asset.id === id && asset.kind === "video"));
  useEffect(() => {
    const missing = faceAssets.filter((id) => !faceTracks[id]);
    if (!token || !projectId || missing.length === 0) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    for (const id of missing) {
      request("/v1/projects/" + projectId + "/assets/" + id + "/faces")
        .then((result) => {
          if (cancelled) return;
          if (result.pending) { timer = setTimeout(() => setFaceRetry((n) => n + 1), (result.retryAfterSeconds ?? 5) * 1000); return; }
          if (typeof result.step === "number" && Array.isArray(result.boxes)) setFaceTracks((current) => ({ ...current, [id]: { step: result.step, boxes: result.boxes } }));
        })
        .catch(() => undefined);
    }
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [token, projectId, faceAssets.join(","), faceRetry]);
  // Person cut-outs for previewing background changes and cutaways behind you (made once per video, in the background).
  const matteAssets = [...new Set(videoClips.filter((clip) => (clip.transform?.background && clip.transform.background !== "none") || brolls.some((b) => b.transform?.mode === "behind" && b.timelineStartUs < clip.timelineEndUs && b.timelineEndUs > clip.timelineStartUs)).map((clip) => clip.assetId))];
  useEffect(() => {
    const missing = matteAssets.filter((id) => !matteUrls[id]);
    if (!token || !projectId || missing.length === 0) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    for (const id of missing) {
      request("/v1/projects/" + projectId + "/assets/" + id + "/matte-url")
        .then((result) => {
          if (cancelled) return;
          if (result.pending) { timer = setTimeout(() => setMatteRetry((n) => n + 1), (result.retryAfterSeconds ?? 8) * 1000); return; }
          if (typeof result.url === "string") setMatteUrls((current) => ({ ...current, [id]: /^https?:\/\//.test(result.url) ? result.url : API + result.url }));
        })
        .catch(() => undefined);
    }
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [token, projectId, matteAssets.join(","), matteRetry]);
  const stillAssets = useMemo(() => Object.fromEntries(assets.map((asset) => [asset.id, asset.kind === "image"])), [assets]);
  const assetSizes = useMemo(() => Object.fromEntries(assets.filter((asset) => Number(asset.metadata.width) > 0 && Number(asset.metadata.height) > 0).map((asset) => [asset.id, { width: Number(asset.metadata.width), height: Number(asset.metadata.height) }])), [assets]);

  // Selecting a clip cues the player to the start of that clip's source range.
  useEffect(() => {
    const player = playerRef.current;
    if (player && selectedClip && sourceUrl && previewMode === "source") player.currentTime = selectedClip.sourceStartUs / 1_000_000;
  }, [selectedClipId, sourceUrl, previewMode]);

  // The transcript of the main video, for editing by words.
  useEffect(() => {
    const id = videoClips[0]?.assetId ?? mainVideo?.id;
    if (!token || !projectId || !id || segmentsFor === id || transcribing?.assetId === id) return;
    let cancelled = false;
    request("/v1/projects/" + projectId + "/assets/" + id + "/transcript").then((result) => { if (!cancelled && result.segments?.length) { setSegments(result.segments); setSegmentsFor(id); } }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [token, projectId, videoClips[0]?.assetId, mainVideo?.id, segmentsFor, transcribing]);

  async function refreshLearned() {
    if (!token) return;
    try { setLearned(await request("/v1/me/preferences")); } catch { setLearned(null); }
  }
  async function resetLearned() {
    setBusy(true);
    try { await request("/v1/me/preferences", { method: "DELETE" }); await refreshLearned(); setStatus("Learned preferences cleared"); }
    catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refreshLearned(); }, [token, proposal?.status, revision, renderJobId]);

  /** Show a source moment: in the live preview when it is in the cut, otherwise in the original footage. */
  function seekSource(sourceUs: number, assetId = segmentsFor || sourceAssetId) {
    const inCut = sourceToTimeline(videoClips, assetId, sourceUs);
    if (inCut !== undefined && previewMode !== "source") { setPreviewMode("edit"); liveRef.current?.seek(inCut); return; }
    setPreviewMode("source");
    setTimeout(() => { const player = playerRef.current; if (player) player.currentTime = sourceUs / 1_000_000; }, 0);
  }
  function onLiveTime(us: number) {
    liveUsRef.current = us;
    const now = performance.now();
    if (now - lastLiveReport.current > 120) { lastLiveReport.current = now; setLiveUs(us); }
  }
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
  /** Anchor point: the selected words, else the playhead, else the selected clip's start. */
  function anchorPoint(): { anchorAssetId: string; anchorSourceUs: number; where: string } | undefined {
    if (selection && segmentsFor && words[selection.from]) {
      const at = words[Math.min(selection.from, selection.to)]!.startUs;
      if (sourceToTimeline(videoClips, segmentsFor, at) !== undefined) return { anchorAssetId: segmentsFor, anchorSourceUs: at, where: "at the selected words" };
    }
    if (previewMode === "edit" && !selectedClip) {
      const at = timelineToSource(videoClips, liveUsRef.current);
      if (at) return { anchorAssetId: at.assetId, anchorSourceUs: Math.round(at.sourceUs), where: "at the playhead" };
    }
    const anchorClip = selectedClip ?? videoClips[0];
    if (!anchorClip) return undefined;
    const player = playerRef.current;
    const playheadUs = player && previewMode === "source" && sourceUrl ? Math.round(player.currentTime * 1_000_000) : anchorClip.sourceStartUs;
    const inside = videoClips.some((clip) => clip.assetId === anchorClip.assetId && playheadUs >= clip.sourceStartUs && playheadUs < clip.sourceEndUs);
    return { anchorAssetId: anchorClip.assetId, anchorSourceUs: inside ? playheadUs : anchorClip.sourceStartUs, where: inside ? "at the playhead" : "at the start of the selected clip" };
  }
  function addBroll(assetId = brollAssetId) {
    const anchor = anchorPoint();
    if (!anchor) { setStatus("Add a video clip first"); return; }
    void applyEdit([{ type: "add-broll", assetId, anchorAssetId: anchor.anchorAssetId, anchorSourceUs: anchor.anchorSourceUs, durationUs: Math.round(brollSeconds * 1_000_000), mode: brollMode }], "Cutaway added " + anchor.where);
  }
  function addSoundEffect() {
    const anchor = anchorPoint();
    if (!anchor) { setStatus("Add a video clip first"); return; }
    void applyEdit([{ type: "add-sfx", kind: sfxKind, anchorAssetId: anchor.anchorAssetId, anchorSourceUs: anchor.anchorSourceUs }], (SFX_LABEL[sfxKind] ?? "Sound") + " added " + anchor.where);
  }
  function addGraphic(text = gfxText, kind = gfxKind) {
    const anchor = anchorPoint();
    if (!anchor) { setStatus("Add a video clip first"); return; }
    if (!text.trim()) { setStatus("Enter the text first"); return; }
    void applyEdit([{ type: "add-graphic", kind, text: text.trim(), ...(gfxSubtitle.trim() && kind !== "callout" ? { subtitle: gfxSubtitle.trim() } : {}), anchorAssetId: anchor.anchorAssetId, anchorSourceUs: anchor.anchorSourceUs, durationUs: Math.round(gfxSeconds * 1_000_000), position: kind === "lower-third" ? "bottom" : gfxPosition, color: gfxColor }], (kind === "title" ? "Title" : kind === "callout" ? "Callout" : "Name caption") + " added " + anchor.where).then((ok) => { if (ok) { setGfxText(""); setGfxSubtitle(""); } });
  }
  /** Composes an instrumental for the saved cut (its length, lifting at its cuts) and lays it under the video. */
  async function generateMusicBed() {
    if (!projectId || revision === 0) { setStatus("Make a cut first, so the music can match it"); return; }
    setBusy(true);
    setStatus("Composing music for this cut…");
    try {
      const result = await request("/v1/projects/" + projectId + "/music/generate", { method: "POST", body: JSON.stringify({ revision, mood: musicMood, brief: { intent: brief || projectName, audience: "", channel: platform === "youtube" ? "youtube" : "short-form" }, seed: Math.floor(Math.random() * 1_000_000_000) }) });
      setAssets((current) => [...current.filter((asset) => asset.id !== result.asset.id), result.asset]);
      setMusicAssetId(result.asset.id);
      setBusy(false);
      await applyEdit([{ type: "set-music", assetId: result.asset.id, volumeDb: musicClip ? Number(musicClip.transform?.volumeDb ?? musicVolume) : musicVolume, duck: musicDuck }], "Music added: " + result.music.description);
    } catch (error) { setStatus(errorMessage(error)); setBusy(false); }
  }

  async function request(path: string, init: RequestInit = {}, accessToken = token, retried = false): Promise<any> {
    const response = await fetch(API + path, {
      ...init,
      credentials: "include",
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(accessToken ? { authorization: "Bearer " + accessToken } : {}), ...init.headers },
    });
    if (response.status === 401 && accessToken && !retried && !path.startsWith("/auth/")) {
      // The 15-minute access token expired: rotate the refresh session once and retry.
      const session = await refreshSession().catch(() => null);
      if (session) { setToken(session.accessToken); return request(path, init, session.accessToken, true); }
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
  useEffect(() => {
    if (token) return;
    refreshSession().then((result) => { setToken(result.accessToken); setUserEmail(result.user.email); }).catch(() => undefined).finally(() => setSessionChecked(true));
  }, []);

  // After signing in (or a reload), come back to the project and step the person was on.
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  useEffect(() => {
    if (!token || projectId) return;
    let cancelled = false;
    request("/v1/projects").then((result) => {
      if (cancelled) return;
      const list: Project[] = result.projects ?? [];
      setProjects(list);
      setProjectsLoaded(true);
      const target = list.find((project) => project.id === recall(LAST_PROJECT_KEY));
      const last = recall(LAST_SCREEN_KEY) as Screen;
      if (target && last && last !== "projects") void openProject(target, last);
    }).catch(() => { if (!cancelled) setProjectsLoaded(true); });
    return () => { cancelled = true; };
  }, [token]);

  async function signOut() {
    await request("/auth/logout", { method: "POST" }).catch(() => undefined);
    setToken(""); setUserEmail(""); setProjects([]); setProjectId(""); setScreen("projects");
    setStatus("Signed out");
  }

  function resetProjectState() {
    setAssets([]); setTimeline({ durationUs: 0, tracks: [] }); setRevision(0); setProposal(null);
    setPlan(null); setPlanApplied(false); setCheck(null); setSegments([]); setSegmentsFor(""); setSelection(null); setSelectedClipId("");
    setRenderJobId(""); setRenderJobStatus(""); setRenderUrl(""); setBrief("");
  }

  async function createProject() {
    const name = (newName.trim() || "Video " + new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })).replace(/\s+/g, " ");
    // Same rule as the server: names are unique per person, ignoring case and extra spaces.
    const clash = projects.find((project) => project.name.trim().replace(/\s+/g, " ").toLowerCase() === name.toLowerCase());
    if (clash) { setStatus("You already have a video called \"" + clash.name + "\". Choose a different name."); return; }
    setBusy(true);
    try {
      const result = await request("/v1/projects", { method: "POST", body: JSON.stringify({ name }) });
      resetProjectState();
      setProjectId(result.project.id); setProjectName(result.project.name); remember(LAST_PROJECT_KEY, result.project.id);
      setProjects((current) => [...current.filter((project) => project.id !== result.project.id), result.project]);
      setNewName(""); setScreen("describe");
      setStatus("Project created");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function deleteProject() {
    const project = currentProject;
    if (!project || deleteConfirm.trim().toLowerCase() !== project.name.trim().toLowerCase()) return;
    setBusy(true);
    try {
      const result = await request("/v1/projects/" + project.id, { method: "DELETE", body: JSON.stringify({ confirmName: deleteConfirm }) });
      setProjects((current) => current.filter((item) => item.id !== project.id));
      resetProjectState(); setProjectId(""); setSourceUrls({}); setFaceTracks({}); setMatteUrls({}); setDeleteConfirm(""); setScreen("projects");
      if (recall(LAST_PROJECT_KEY) === project.id) remember(LAST_PROJECT_KEY, "");
      setStatus("Deleted “" + project.name + "” and its " + result.removedObjects + " stored file" + (result.removedObjects === 1 ? "" : "s"));
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function openProject(project: Project, preferred?: Screen) {
    setBusy(true);
    try {
      resetProjectState();
      setProjectId(project.id); remember(LAST_PROJECT_KEY, project.id); setProjectName(project.name); setRevision(project.revision);
      const [assetResult, revisionResult] = await Promise.all([
        request("/v1/projects/" + project.id + "/assets"),
        project.revision > 0 ? request("/v1/projects/" + project.id + "/revisions/" + project.revision) : Promise.resolve(null),
      ]);
      setAssets(assetResult.assets);
      const opened: Timeline = revisionResult ? revisionResult.revision.timeline : { durationUs: 0, tracks: [] };
      setTimeline(opened);
      if (revisionResult?.revision.tailoring?.intent) setBrief(revisionResult.revision.tailoring.intent);
      const hasCut = (opened.tracks.find((track) => track.kind === "video")?.clips.length ?? 0) > 0;
      const target: Screen = preferred && (hasCut || preferred === "describe") ? preferred : hasCut ? "edit" : "describe";
      setScreen(target === "plan" ? (hasCut ? "edit" : "describe") : target);
      setStatus("Opened " + project.name);
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  /** Transcription starts as soon as a video is uploaded, so it runs while the person describes the video. */
  function startTranscription(assetId: string, pid = projectId) {
    const base = "/v1/projects/" + pid + "/assets/" + assetId + "/transcript";
    const promise = (async () => {
      const existing = await request(base).catch(() => ({ segments: [] }));
      const result = existing.segments?.length ? existing : await request(base, { method: "POST" });
      if (!result.segments?.length) throw new Error("No speech was found in this video");
      setSegments(result.segments); setSegmentsFor(assetId);
    })();
    const tracked = promise.finally(() => setTranscribing((current) => (current?.promise === tracked ? null : current)));
    setTranscribing({ assetId, promise: tracked });
    tracked.catch((error) => setStatus(errorMessage(error)));
    return tracked;
  }

  async function uploadAsset(event: { currentTarget: HTMLInputElement }, purpose: "main" | "media") {
    const input = event.currentTarget; // React clears currentTarget once the handler yields
    const file = input.files?.[0];
    if (!file || !projectId) { setStatus(projectId ? "Choose a file first" : "Create a project first"); return; }
    const kind = purpose === "main" ? "video" : kindOfFile(file);
    setBusy(true);
    setStatus("Uploading " + file.name + "…");
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch(API + "/v1/projects/" + projectId + "/assets/upload?kind=" + encodeURIComponent(kind), { method: "POST", body: form, headers: token ? { authorization: "Bearer " + token } : {} });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message ?? "Upload failed");
      setAssets((current) => [...current.filter((asset) => asset.id !== body.asset.id), body.asset]);
      setStatus("Uploaded " + file.name);
      if (purpose === "main") void startTranscription(body.asset.id);
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
    const index = videoClips.findIndex((clip) => clip.id === clipId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= videoClips.length) { setStatus("That part is already at the " + (direction < 0 ? "start" : "end")); return; }
    const order = videoClips.map((clip) => clip.id);
    [order[index], order[target]] = [order[target] as string, order[index] as string];
    void applyEdit([{ type: "reorder-clips", clipIds: order }], direction < 0 ? "Clip moved earlier" : "Clip moved later");
  }
  function removeSelectedClip(clipId = selectedClipId) {
    if (!clipId) return;
    setSelectedClipId("");
    void applyEdit([{ type: "remove-clip", clipId, reason: "Removed in the editor" }], "Removed");
  }
  function trimSelectedClip(startDeltaUs: number, endDeltaUs: number) {
    if (!selectedClip) { setStatus("Select a clip first"); return; }
    const source = assets.find((asset) => asset.id === selectedClip.assetId);
    const start = Math.max(0, selectedClip.sourceStartUs + startDeltaUs);
    const end = Math.min(source?.durationUs ?? Number.MAX_SAFE_INTEGER, selectedClip.sourceEndUs + endDeltaUs);
    if (end - start < 300_000) { setStatus("A clip must stay at least 0.3s long"); return; }
    void applyEdit([{ type: "trim-clip", clipId: selectedClip.id, sourceStartUs: start, sourceEndUs: end }], "Clip trimmed");
  }
  function saveCaption(clip: TimelineClip) {
    const text = (captionDrafts[clip.id] ?? String(clip.transform?.text ?? "")).trim();
    if (!text) { setStatus("A caption cannot be empty"); return; }
    void applyEdit([{ type: "update-caption", clipId: clip.id, text }], "Caption corrected").then((ok) => { if (ok) setCaptionDrafts((current) => { const { [clip.id]: _removed, ...rest } = current; return rest; }); });
  }
  function handleClipKeyDown(event: KeyboardEvent<HTMLButtonElement>, clip: TimelineClip, kind: string) {
    if (kind === "video" && event.key === "ArrowLeft") { event.preventDefault(); setSelectedClipId(clip.id); nudgeSelectedClip(-1, clip.id); }
    if (kind === "video" && event.key === "ArrowRight") { event.preventDefault(); setSelectedClipId(clip.id); nudgeSelectedClip(1, clip.id); }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); setSelectedClipId(clip.id); removeSelectedClip(clip.id); }
  }

  // Editing by transcript.
  function pickWord(index: number, extend: boolean) {
    setSelection((current) => (extend && current ? { from: current.from, to: index } : { from: index, to: index }));
    const word = words[index];
    if (word) seekSource(word.startUs);
  }
  const selectionRange = selection && words.length ? rangeForWords(words, selection.from, selection.to) : null;
  const selectionKept = selection ? kept.slice(Math.min(selection.from, selection.to), Math.max(selection.from, selection.to) + 1) : [];
  const selectionText = selection ? words.slice(Math.min(selection.from, selection.to), Math.max(selection.from, selection.to) + 1).map((w) => w.text).join(" ") : "";
  function cutSelection() {
    if (!selectionRange || !segmentsFor) return;
    const ops = removeRangeOps(selectionRange, videoClips, captionCues, words, segmentsFor);
    if (!ops.length) { setStatus("Those words are already cut"); return; }
    void applyEdit(ops, "Cut “" + selectionText.slice(0, 40) + (selectionText.length > 40 ? "…" : "") + "”").then((ok) => { if (ok) setSelection(null); });
  }
  function restoreSelection() {
    if (!selectionRange || !segmentsFor) return;
    const ops = restoreRangeOps(selectionRange, videoClips, words, segmentsFor);
    if (!ops.length) { setStatus("Those words are already in the cut"); return; }
    void applyEdit(ops, "Brought back “" + selectionText.slice(0, 40) + (selectionText.length > 40 ? "…" : "") + "”").then((ok) => { if (ok) setSelection(null); });
  }

  /** Make sure the video is transcribed and on the timeline; returns the revision to work from. */
  async function prepareSource(video: Asset, steps: number): Promise<number> {
    setStatus("Step 1 of " + steps + ": listening to the video (the first run downloads the speech model and can take a few minutes)…");
    if (transcribing?.assetId === video.id) await transcribing.promise;
    else if (segmentsFor !== video.id) await startTranscription(video.id);
    setStatus("Step 2 of " + steps + ": preparing the timeline…");
    const lengthUs = video.durationUs && video.durationUs > 0 ? video.durationUs : 10_000_000;
    const usesVideo = videoClips.some((clip) => clip.assetId === video.id);
    let workingRevision = revision;
    if (!usesVideo || revision === 0) {
      const fresh: Timeline = { durationUs: lengthUs, tracks: [{ id: "video", kind: "video", clips: [{ id: "source-" + video.id.slice(0, 8), assetId: video.id, sourceStartUs: 0, sourceEndUs: lengthUs, timelineStartUs: 0, timelineEndUs: lengthUs }] }] };
      const saved = await request("/v1/projects/" + projectId + "/revisions", { method: "POST", body: JSON.stringify({ timeline: fresh }) });
      workingRevision = saved.revision.revision;
      setRevision(workingRevision);
      setTimeline(saved.revision.timeline);
    }
    return workingRevision;
  }

  async function planVideo() {
    const video = mainVideo;
    if (!projectId || !video) { setStatus("Upload a video first"); return; }
    if (!brief.trim()) { setStatus("Describe the video first: what it is about, who it is for, and where it will go"); document.querySelector<HTMLTextAreaElement>("#brief")?.focus(); return; }
    setBusy(true); setPlan(null); setPlanApplied(false); setProposal(null);
    try {
      const workingRevision = await prepareSource(video, 3);
      setStatus("Step 3 of 3: the director is watching and reading your video…");
      const result = await request("/v1/projects/" + projectId + "/director/plan", { method: "POST", body: JSON.stringify({ revision: workingRevision, brief }) });
      const next: DirectorPlan = result.plan;
      setPlan(next);
      setPicked(Object.fromEntries(next.suggestions.map((item) => [item.id, item.kind !== "advice"])));
      setPlanText(Object.fromEntries(next.suggestions.filter((item) => typeof item.text === "string" && item.text).map((item) => [item.id, item.text!])));
      setScreen("plan");
      setStatus("Plan ready: " + next.suggestions.length + " suggestions. Untick anything you don't want, then apply");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function editMyself() {
    const video = mainVideo;
    if (!projectId || !video) { setStatus("Upload a video first"); return; }
    setBusy(true);
    try { await prepareSource(video, 2); setScreen("edit"); setStatus("The whole video is on the timeline. Cut words in the transcript, or use the tools on the left"); }
    catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function applyPlan() {
    if (!projectId || !plan) return;
    setBusy(true);
    setStatus("Building your edit from the plan…");
    try {
      const editedPlan = { ...plan, suggestions: plan.suggestions.map((item) => planText[item.id] !== undefined ? { ...item, text: planText[item.id]!.trim() || item.text } : item) };
      const accepted = editedPlan.suggestions.filter((item) => picked[item.id]).map((item) => item.id);
      const result = await request("/v1/projects/" + projectId + "/director/apply", { method: "POST", body: JSON.stringify({ revision, plan: editedPlan, accepted }) });
      setRevision(result.revision.revision); setTimeline(result.revision.timeline);
      setRenderUrl(""); setRenderJobId(""); setRenderJobStatus("");
      if (result.platform && PLATFORMS[result.platform]) setPlatform(result.platform);
      if (result.music) { const listed = await request("/v1/projects/" + projectId + "/assets").catch(() => null); if (listed) setAssets(listed.assets); }
      setPlanApplied(true); setCheck(null); setScreen("edit");
      setStatus("Plan applied (revision " + result.revision.revision + ")" + (result.music ? ". Music: " + result.music.description : ""));
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  /** A change in the person's own words; the director answers with suggestions to tick, as for the first cut. */
  async function askDirector() {
    if (!projectId || !revision || askText.trim().length < 3) return;
    setBusy(true); setAskPlan(null);
    setStatus("Working out how to “" + askText.trim().slice(0, 60) + "”…");
    try {
      // "Here" means the playhead: send where it is in the original video.
      const here = timelineToSource(videoClips, liveUsRef.current);
      const result = await request("/v1/projects/" + projectId + "/director/ask", { method: "POST", body: JSON.stringify({ revision, instruction: askText.trim(), ...(here && here.assetId === videoClips[0]?.assetId ? { playheadS: here.sourceUs / 1e6 } : {}) }) });
      const next: DirectorPlan = result.plan;
      setAskPlan(next);
      setAskPicked(Object.fromEntries(next.suggestions.map((item) => [item.id, item.kind !== "advice"])));
      const actionable = next.suggestions.filter((item) => item.kind !== "advice").length;
      setStatus(actionable ? "Suggested " + actionable + " change" + (actionable === 1 ? "" : "s") + ": review and apply" : "No change suggested");
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function applyAsk() {
    if (!projectId || !askPlan) return;
    setBusy(true);
    try {
      const accepted = askPlan.suggestions.filter((item) => askPicked[item.id] && item.kind !== "advice").map((item) => item.id);
      const result = await request("/v1/projects/" + projectId + "/director/apply", { method: "POST", body: JSON.stringify({ revision, plan: askPlan, accepted, keepTailoring: true }) });
      setRevision(result.revision.revision); setTimeline(result.revision.timeline);
      setRenderUrl(""); setRenderJobId(""); setRenderJobStatus("");
      if (result.platform && PLATFORMS[result.platform]) setPlatform(result.platform);
      // Music, stock and voice-overs made on the server are new assets.
      const listed = await request("/v1/projects/" + projectId + "/assets").catch(() => null); if (listed) setAssets(listed.assets);
      setAskPlan(null); setAskText(""); setCheck(null);
      setStatus("Changed (revision " + result.revision.revision + ")" + (result.music ? ". Music: " + result.music.description : "") + (Array.isArray(result.notes) && result.notes.length ? ". " + result.notes.join(" ") : ""));
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function runCheck(atRevision = revision) {
    if (!projectId || !atRevision) return;
    setBusy(true);
    setStatus("Checking your edit: cuts, pauses, picture, text and sound…");
    try {
      const result = await request("/v1/projects/" + projectId + "/director/check", { method: "POST", body: JSON.stringify({ revision: atRevision, platform, ...(brief.trim() ? { brief } : {}) }) });
      setCheck({ ...result, revision: atRevision });
      setFixPicked(Object.fromEntries(result.issues.filter((issue: CheckIssue) => issue.fix).map((issue: CheckIssue) => [issue.id, issue.severity === "fix"])));
      const fixable = result.issues.filter((issue: CheckIssue) => issue.fix).length;
      setStatus("Check done: " + (result.issues.length === 0 ? "nothing to fix" : result.issues.length + " finding" + (result.issues.length === 1 ? "" : "s") + (fixable ? ", " + fixable + " with a fix" : "")));
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function applyFixes() {
    if (!projectId || !check) return;
    const fixes = check.issues.filter((issue) => issue.fix && fixPicked[issue.id]).map((issue) => ({ title: issue.title, ...(typeof issue.atS === "number" ? { atS: issue.atS } : {}), operations: issue.fix!.operations }));
    if (!fixes.length) return;
    setBusy(true);
    try {
      const result = await request("/v1/projects/" + projectId + "/director/fix", { method: "POST", body: JSON.stringify({ revision: check.revision, fixes }) });
      setRevision(result.revision.revision); setTimeline(result.revision.timeline);
      setRenderUrl(""); setRenderJobId(""); setRenderJobStatus("");
      setStatus("Fixed " + result.applied.length + (result.skipped.length ? " (" + result.skipped.length + " no longer applied)" : "") + "; checking again…");
      setBusy(false);
      await runCheck(result.revision.revision);
    } catch (error) { setStatus(errorMessage(error)); setBusy(false); }
  }
  function showIssue(issue: CheckIssue) {
    if (typeof issue.atS !== "number") return;
    setPreviewMode("edit");
    setTimeout(() => liveRef.current?.seek(Math.round(issue.atS! * 1e6)), 0);
  }

  async function createHighlights() {
    const video = mainVideo;
    if (!projectId || !video) { setStatus("Upload a video first"); return; }
    setBusy(true); setProposal(null); setPlan(null);
    try {
      const workingRevision = await prepareSource(video, 3);
      setStatus("Step 3 of 3: choosing the best moments for your goal…");
      const target = secondsFromBrief(brief) ?? (platform === "youtube" ? 90 : 30);
      const found = await request("/v1/projects/" + projectId + "/proposals", {
        method: "POST",
        body: JSON.stringify({ revision: workingRevision, strategyId: "highlight-reel", profile: { intent: brief.trim() || "The strongest, clearest moments", audience: "", channel: platform === "youtube" ? "youtube" : "short-form", targetDurationUs: target * 1_000_000, constraints: [] } }),
      });
      setProposal(found.proposal);
      setScreen("plan");
      const picks = groupHighlights(found.proposal.operations).length;
      setStatus(picks ? "Highlights ready: review the " + picks + " suggested highlight" + (picks === 1 ? "" : "s") + ", then Accept" : found.proposal.rationale);
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
      if (decision === "accepted") { setCheck(null); setScreen("edit"); }
      setStatus("Proposal " + decision);
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function submitRender() {
    if (!projectId || !revision) { setStatus("Make a cut before exporting"); return; }
    setBusy(true);
    try {
      const preset = PLATFORMS[platform]!;
      const result = await request("/v1/projects/" + projectId + "/renders", {
        method: "POST",
        body: JSON.stringify({ revision, idempotencyKey: projectId + ":" + revision + ":" + platform, settings: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: preset.width, height: preset.height, frameRate: 30, fit: preset.fit, captionStyle: preset.captionStyle } }),
      });
      setRenderJobId(result.job.id); setRenderUrl(""); setRenderJobStatus("queued 0%"); setStatus("Export started (" + preset.label + ")…"); void pollRender(result.job.id);
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!projectId || revision === 0) return;
    setProjects((current) => current.map((project) => project.id === projectId && project.revision !== revision ? { ...project, revision, updatedAt: new Date().toISOString() } : project));
  }, [revision, projectId]);
  const assetName = (id: string) => { const asset = assets.find((item) => item.id === id); return asset ? String(asset.metadata.filename ?? asset.kind) : id.startsWith("generated:") ? "Generated" : "Media"; };
  const clipLabel = (kind: string, clip: TimelineClip) => kind === "caption" ? String(clip.transform?.text ?? "Caption")
    : kind === "overlay" ? (clip.transform?.role === "graphic" ? String(clip.transform?.text ?? "Text") : clip.transform?.role === "progress" ? "Progress bar" : "Cutaway · " + assetName(clip.assetId))
    : kind === "audio" ? (clip.transform?.role === "sfx" ? "Sound · " + (SFX_LABEL[String(clip.transform?.kind)] ?? "effect") : clip.transform?.role === "voiceover" ? "Voice-over · " + assetName(clip.assetId) : "Music · " + assetName(clip.assetId))
    : assetName(clip.assetId) + [clip.transform?.zoom ? " · " + (clip.transform.zoom === "punch" ? "punch-in" : "push-in") : "", clip.transform?.transitionIn ? " · " + (TRANSITION_LABEL[String(clip.transform.transitionIn)] ?? "") + " in" : ""].join("");
  // Semantic tracks: the story, what is shown over it, text, and sound.
  const lanes = [
    { name: "Story", kind: "video", clips: videoClips },
    { name: "Visuals", kind: "overlay", clips: brolls },
    { name: "Text", kind: "overlay", clips: [...graphicsClips, ...(progressClip ? [progressClip] : [])] },
    { name: "Captions", kind: "caption", clips: captionCues },
    { name: "Sound", kind: "audio", clips: timeline.tracks.filter((track) => track.kind === "audio").flatMap((track) => track.clips) },
  ].filter((lane) => lane.clips.length > 0 || lane.name === "Story");
  const steps: Array<{ label: string; screen: Screen; enabled: boolean; done: boolean }> = [
    { label: "Upload", screen: "describe", enabled: true, done: hasVideo },
    { label: "Describe", screen: "describe", enabled: hasVideo, done: edited },
    { label: "Edit", screen: "edit", enabled: edited, done: edited && Boolean(check) },
    { label: "Check", screen: "check", enabled: edited, done: Boolean(check) && check?.revision === revision },
    { label: "Export", screen: "export", enabled: edited, done: Boolean(renderUrl) },
  ];
  const stepBar = <nav aria-label="Workflow" className="steps">{steps.map((step, index) => {
    const isCurrent = index === 0 ? screen === "describe" && !hasVideo : index === 1 ? (screen === "describe" && hasVideo) || screen === "plan" : index === 2 ? screen === "edit" : index === 3 ? screen === "check" : screen === "export";
    return <button key={step.label} type="button" className={"step" + (isCurrent ? " current" : "") + (step.done && !isCurrent ? " done" : "")} aria-current={isCurrent ? "step" : undefined} disabled={!step.enabled || busy} onClick={() => setScreen(step.screen)}><span className="num" aria-hidden="true">{step.done && !isCurrent ? "✓" : index + 1}</span><span className="step-label">{step.label}</span></button>;
  })}</nav>;

  const statusPill = <div className="status-pill" role="status" aria-live="polite" title={status}><span className={"status-dot" + (busy ? " busy" : "")} />{status}</div>;

  // ── Sign in ────────────────────────────────────────────────────────────────────────────────
  if (!userEmail) {
    return <div className="app-shell">
      <header className="topbar"><span className="brand">VideoCraft</span><div className="spacer" />{statusPill}</header>
      <main className="center-page">
        <section className="card auth-card" aria-label="Sign in">
          <h1>{authMode === "login" ? "Sign in" : "Create your account"}</h1>
          <p className="muted">Describe your video in your own words; VideoCraft makes the first cut and you approve every part.</p>
          <div className="segmented" role="tablist"><button role="tab" aria-selected={authMode === "login"} className={authMode === "login" ? "on" : ""} onClick={() => setAuthMode("login")}>Sign in</button><button role="tab" aria-selected={authMode === "register"} className={authMode === "register" ? "on" : ""} onClick={() => setAuthMode("register")}>Create account</button></div>
          <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} /></label>
          <button className="primary" onClick={authenticate} disabled={busy || !email || password.length < 10}>{authMode === "login" ? "Sign in" : "Create account"}</button>
          {!sessionChecked && <p className="muted">Checking for an existing session…</p>}
        </section>
      </main>
    </div>;
  }

  // ── Videos (projects) ─────────────────────────────────────────────────────────────────────
  if (screen === "projects" || !projectId) {
    const sorted = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return <div className="app-shell">
      <header className="topbar"><span className="brand">VideoCraft</span><div className="spacer" />{statusPill}<details className="menu"><summary className="btn">{userEmail}</summary><div className="menu-body"><button className="btn" onClick={signOut} disabled={busy}>Sign out</button></div></details></header>
      <main className="page">
        <div className="page-head">
          <div><h1>Your videos</h1><p className="muted">Pick up where you left off, or start a new one.</p></div>
          <form className="new-video" onSubmit={(event) => { event.preventDefault(); void createProject(); }}>
            <label className="sr-only" htmlFor="new-name">Name for the new video</label>
            <input id="new-name" placeholder="Name (optional)" value={newName} maxLength={120} onChange={(event) => setNewName(event.target.value)} />
            <button type="submit" className="primary" disabled={busy}>New video</button>
          </form>
        </div>
        {!projectsLoaded && <p className="muted">Loading your videos…</p>}
        {projectsLoaded && sorted.length === 0 && <div className="card empty"><h2>No videos yet</h2><p className="muted">Start with New video: upload a talk, interview or vlog and describe what you want.</p></div>}
        <div className="project-grid">{sorted.map((project) => <button key={project.id} type="button" className="card project-card" onClick={() => void openProject(project)} disabled={busy}>
          <span className="thumb" aria-hidden="true" />
          <span className="project-meta"><strong>{project.name}</strong><span className={"tag " + (project.revision > 0 ? "ok" : "")}>{project.revision > 0 ? "Edited" : "Not edited yet"}</span><span className="muted small">Edited {new Date(project.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span></span>
        </button>)}</div>
      </main>
    </div>;
  }

  const projectHeader = <header className="topbar">
    <button className="btn icon" aria-label="Back to your videos" onClick={() => setScreen("projects")} disabled={busy}>‹</button>
    <div className="title-block"><span className="project-title">{currentProject?.name ?? projectName}</span><span className="muted small">{revision > 0 ? "Saved · revision " + revision : "Not edited yet"}</span></div>
    {stepBar}
    {statusPill}
    <details className="menu" onToggle={() => setDeleteConfirm("")}><summary className="btn" aria-label="Project menu">⋯</summary><div className="menu-body danger-zone">
      <p className="small">Signed in as {userEmail}</p>
      <button className="btn" onClick={signOut} disabled={busy}>Sign out</button>
      <hr />
      <p className="small muted">Delete “{currentProject?.name}”, its uploads, edits and exports for good. This cannot be undone.</p>
      <label>Type the project name to confirm<input value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} placeholder={currentProject?.name} autoComplete="off" /></label>
      <button className="danger" onClick={deleteProject} disabled={busy || !currentProject || deleteConfirm.trim().toLowerCase() !== currentProject.name.trim().toLowerCase()}>Delete project</button>
    </div></details>
  </header>;

  const player = <div className="player">
    <div className="preview-tabs" role="tablist"><button role="tab" aria-selected={previewMode === "edit"} className={previewMode === "edit" ? "on" : ""} onClick={() => setPreviewMode("edit")} disabled={videoClips.length === 0}>Edit</button><button role="tab" aria-selected={previewMode === "source"} className={previewMode === "source" ? "on" : ""} onClick={() => setPreviewMode("source")}>Original</button><button role="tab" aria-selected={previewMode === "render"} className={previewMode === "render" ? "on" : ""} onClick={() => setPreviewMode("render")}>Export</button></div>
    {previewMode === "edit" && videoClips.length > 0 ? <LivePreview ref={liveRef} tracks={timeline.tracks} durationUs={timeline.durationUs} urls={sourceUrls} shape={(PLATFORMS[platform]?.width ?? 9) < (PLATFORMS[platform]?.height ?? 16) ? "tall" : PLATFORMS[platform]?.width === PLATFORMS[platform]?.height ? "square" : "wide"} fit={PLATFORMS[platform]?.fit ?? "cover"} output={{ width: PLATFORMS[platform]?.width ?? 1080, height: PLATFORMS[platform]?.height ?? 1920 }} captionStyle={PLATFORMS[platform]?.captionStyle ?? "bold-pop"} faces={faceTracks} sizes={assetSizes} mattes={matteUrls} stills={stillAssets} onRetryMatte={() => { setMatteUrls({}); setMatteRetry((n) => n + 1); }} onTime={onLiveTime} />
    : <div className={"preview-screen " + ((PLATFORMS[platform]?.width ?? 9) < (PLATFORMS[platform]?.height ?? 16) ? "tall" : "wide")}>{previewMode === "render" ? (renderUrl ? <video controls src={renderUrl} /> : <span>{renderJobId ? "Exporting " + renderJobStatus : "Your exported video will play here"}</span>) : (sourceUrl ? <video ref={playerRef} controls src={sourceUrl} onTimeUpdate={stopAtClipEnd} /> : <span>{sourceNote || "Preparing the preview…"}</span>)}</div>}
    {previewMode === "source" && sourceNote && sourceUrl && <p className="muted small">{sourceNote}</p>}
  </div>;

  // ── Upload & describe ────────────────────────────────────────────────────────────────────
  if (screen === "describe") {
    const transcribed = Boolean(mainVideo && segmentsFor === mainVideo.id);
    return <div className="app-shell">{projectHeader}
      <main className="page two-col">
        <section className="col narrow" aria-label="Your video">
          {mainVideo ? <div className="card video-card">
            <div className="thumb big" aria-hidden="true" />
            <div className="card-body">
              <div className="row-between"><strong>{String(mainVideo.metadata.filename ?? "Your video")}</strong>{mainVideo.durationUs ? <span className="mono muted small">{formatClock(mainVideo.durationUs)}</span> : null}</div>
              <ul className="checklist">
                <li className="ok">Uploaded and checked</li>
                <li className={transcribed ? "ok" : "pending"}>{transcribed ? "Transcribed: " + words.length + " words" : transcribing ? "Listening to the video…" : "Waiting to transcribe"}</li>
              </ul>
            </div>
          </div> : <label className="card dropzone">
            <span className="drop-title">Upload your video</span>
            <span className="muted small">A talk, interview or vlog works best. It starts transcribing straight away.</span>
            <input type="file" accept="video/*" aria-label="Upload a video" onChange={(event) => void uploadAsset(event, "main")} disabled={busy} />
          </label>}
          {mainVideo && <label className="btn file-btn">Replace video<input type="file" accept="video/*" aria-label="Replace the video" onChange={(event) => void uploadAsset(event, "main")} disabled={busy} /></label>}
        </section>
        <section className="col wide" aria-label="Describe your video">
          <h1>What is this video for?</h1>
          <p className="muted">Say it in your own words. The first cut is built from this, and you approve every part of it.</p>
          <label htmlFor="brief" className="field-label">Description</label>
          <textarea id="brief" rows={4} value={brief} maxLength={2000} placeholder="e.g. A 30 second Reel for new graduates about our mentoring programme. Open on the strongest result, hopeful in tone." onChange={(event) => setBrief(event.target.value)} />
          <fieldset className="chips"><legend className="field-label">Format</legend>{["tiktok", "youtube", "square"].map((key) => <button key={key} type="button" className={"chip" + (platform === key ? " on" : "")} aria-pressed={platform === key} onClick={() => setPlatform(key)}>{PLATFORMS[key]!.short}</button>)}</fieldset>
          <div className="actions">
            <button className="primary" onClick={planVideo} disabled={busy || !mainVideo || !brief.trim()}>Make the first cut</button>
            <button className="btn" onClick={createHighlights} disabled={busy || !mainVideo}>Just find the highlights</button>
            <button className="btn" onClick={editMyself} disabled={busy || !mainVideo}>Edit it myself</button>
            {((plan && !planApplied) || proposal?.status === "proposed") && <button className="link" onClick={() => setScreen("plan")}>Back to the suggestions</button>}
          </div>
        </section>
      </main>
    </div>;
  }

  // ── Review the plan or the highlights ────────────────────────────────────────────────────
  if (screen === "plan") {
    const proposalHighlights = proposal ? groupHighlights(proposal.operations) : [];
    const count = plan ? plan.suggestions.filter((item) => picked[item.id]).length : 0;
    return <div className="app-shell">{projectHeader}
      <main className="page two-col">
        {plan ? <section className="col wide director-panel" aria-label="The first cut">
          <div className="row-between"><h1>The first cut</h1><span className="tag" title={plan.note ?? ""}>{plan.source === "ai" ? "AI director" + (plan.model ? " · " + plan.model : "") : "Built-in director"}</span></div>
          <p className="muted">{plan.summary} Untick what you don't want. Nothing changes until you apply.</p>
          {plan.note && <p className="note">{plan.note}</p>}
          {PLAN_GROUPS.map((group) => { const items = plan.suggestions.filter((item) => group.kinds.includes(item.kind)); return items.length ? <div key={group.name} className="plan-group"><h2 className="group-title">{group.name}</h2>
            <ul className="suggestion-list">{items.map((item) => <li key={item.id} className={"card suggestion" + (picked[item.id] || item.kind === "advice" ? "" : " off")}>
              {item.kind !== "advice" && <input type="checkbox" id={"s-" + item.id} checked={Boolean(picked[item.id])} onChange={(event) => setPicked((current) => ({ ...current, [item.id]: event.target.checked }))} />}
              <div className="suggestion-body">
                <label htmlFor={"s-" + item.id}><strong>{item.title}</strong></label>
                <span className="small what">{describeSuggestion(item)}</span>{item.pick && <span className="stock-pick"><img src={item.pick.thumbUrl} alt={"Stock: " + (item.query ?? "")} loading="lazy" /><span className="muted small">{item.pick.credit ?? "Free stock"}</span></span>}
                {planText[item.id] !== undefined && <input aria-label={"Text for " + item.title} value={planText[item.id]} maxLength={120} onChange={(event) => setPlanText((current) => ({ ...current, [item.id]: event.target.value }))} />}
                {item.reason && <details><summary>Why</summary><p className="small muted">{item.reason}</p></details>}
              </div>
            </li>)}</ul></div> : null; })}
        </section> : proposal ? <section className="col wide proposal-panel" aria-label="Suggested highlights">
          <div className="row-between"><h1>Suggested highlights</h1><span className="tag" title="How well the chosen clips match your description">Fit: {proposal.confidence >= 0.7 ? "strong" : proposal.confidence >= 0.45 ? "fair" : "weak"} ({Math.round(proposal.confidence * 100)}%)</span></div>
          <p className="muted">{proposal.rationale}</p>
          <ol className="highlight-list">{proposalHighlights.map((highlight, index) => <li key={index} className="card"><strong className="mono">{formatSeconds(highlight.startUs)}–{formatSeconds(highlight.endUs)}</strong>{typeof highlight.score === "number" && <span className="tag">score {Math.round(highlight.score * 100)}</span>}{highlight.parts > 1 && <span className="tag">{highlight.parts} parts, pauses cut</span>}<p>{highlight.reason}</p></li>)}</ol>
          <details><summary>Evidence</summary><div className="evidence">{proposal.evidence.map((item) => <div key={item.reference}><span>{evidenceLabel(item).source}</span><code>{evidenceLabel(item).reference}{typeof item.startUs === "number" && typeof item.endUs === "number" ? " · " + formatSeconds(item.startUs) + "–" + formatSeconds(item.endUs) : ""}</code>{item.excerpt && <p>{item.excerpt}</p>}</div>)}</div></details>
        </section> : <section className="col wide"><h1>Nothing to review yet</h1><p className="muted">Go back to Describe and make the first cut.</p></section>}
        <aside className="col narrow card summary" aria-label="Result">
          {plan ? <>
            <dl className="facts"><dt>Format</dt><dd>{PLATFORMS[plan.suggestions.find((item) => item.kind === "platform" && picked[item.id])?.platform ?? platform]?.short}</dd><dt>Selected</dt><dd>{count} of {plan.suggestions.filter((item) => item.kind !== "advice").length}</dd></dl>
            <button className="primary" onClick={applyPlan} disabled={busy || planApplied || count === 0}>{planApplied ? "Applied" : "Apply the selected"}</button>
            <p className="small muted">Saved as a new revision. You can still change everything in the editor.</p>
            <button className="btn" onClick={planVideo} disabled={busy}>Plan again</button>
          </> : proposal && proposal.status === "proposed" ? <>
            <button className="primary" onClick={() => void decideProposal("accepted")} disabled={busy}>Accept highlights</button>
            <button className="btn" onClick={() => void decideProposal("rejected")} disabled={busy}>Reject</button>
          </> : <button className="btn" onClick={() => setScreen("describe")}>Back to Describe</button>}
        </aside>
      </main>
    </div>;
  }

  // ── Check ───────────────────────────────────────────────────────────────────────────────
  if (screen === "check") {
    const toFix = check?.issues.filter((issue) => issue.severity === "fix").length ?? 0;
    return <div className="app-shell">{projectHeader}
      <main className="page two-col">
        <section className="col wide check-panel" aria-label="Edit check" data-checked-revision={check?.revision ?? 0}>
          <div className="row-between"><h1>Check your edit</h1>{check && <span className="tag">{check.ai ? "Built-in checks + AI look" : "Built-in checks"}{check.revision !== revision ? " · edited since" : ""}</span>}</div>
          {!check && <p className="muted">A last look before export: clipped words, long pauses, black or frozen picture, text that goes by too fast and music balance. Each finding comes with a fix you can accept.</p>}
          {check?.note && <p className="note">{check.note}</p>}
          {check && <p className="muted">{check.issues.length === 0 ? "Nothing to fix. Ready to export." : toFix + " to fix · " + (check.issues.length - toFix) + " to look at. Warnings never block export."}</p>}
          {check && check.issues.length > 0 && <ul className="suggestion-list issue-list">{check.issues.map((issue) => <li key={issue.id} className={"card suggestion issue-" + issue.severity + (issue.fix && !fixPicked[issue.id] ? " off" : "")}>
            {issue.fix && <input type="checkbox" id={"i-" + issue.id} checked={Boolean(fixPicked[issue.id])} onChange={(event) => setFixPicked((current) => ({ ...current, [issue.id]: event.target.checked }))} />}
            <div className="suggestion-body">
              <label htmlFor={"i-" + issue.id}><span className={"tag sev-" + issue.severity}>{issue.severity === "fix" ? "Fix" : issue.severity === "warn" ? "Look" : "Note"}{issue.source === "ai" ? " · AI" : ""}</span> <strong>{issue.title}</strong></label>
              <span className="small what">{issue.detail}</span>
              {issue.fix && <span className="small fix-label">→ {issue.fix.label}</span>}
              {typeof issue.atS === "number" && <button type="button" className="link small" onClick={() => showIssue(issue)}>Show at {issue.atS.toFixed(1)} s</button>}
            </div>
          </li>)}</ul>}
          <div className="actions">
            <button className={check ? "btn" : "primary"} onClick={() => void runCheck()} disabled={busy}>{check ? "Check again" : "Check my edit"}</button>
            {check && check.issues.some((issue) => issue.fix) && <button className="primary" onClick={applyFixes} disabled={busy || check.revision !== revision || !check.issues.some((issue) => issue.fix && fixPicked[issue.id])}>Apply selected fixes</button>}
            <button className="btn" onClick={() => setScreen("export")} disabled={busy}>Go to export</button>
          </div>
        </section>
        <aside className="col narrow">{player}</aside>
      </main>
    </div>;
  }

  // ── Export ──────────────────────────────────────────────────────────────────────────────
  if (screen === "export") {
    return <div className="app-shell">{projectHeader}
      <main className="page two-col">
        <section className="col wide" aria-label="Export">
          <h1>Export</h1>
          <p className="muted">Pick the format. Captions, titles, music and effects are burned into the file.</p>
          <fieldset className="format-list"><legend className="sr-only">Format</legend>{Object.entries(PLATFORMS).map(([key, preset]) => <label key={key} className={"card format" + (platform === key ? " on" : "")}><input type="radio" name="format" checked={platform === key} onChange={() => setPlatform(key)} /><span className={"frame " + (preset.width < preset.height ? "tall" : preset.width === preset.height ? "square" : "wide")} aria-hidden="true" /><span><strong>{preset.label}</strong><span className="mono small muted">{preset.width} × {preset.height}</span></span></label>)}</fieldset>
          <div className="actions">
            <button className="primary" onClick={submitRender} disabled={busy || !revision || Boolean(renderJobId && !renderUrl && !/^(failed|cancelled)/.test(renderJobStatus))}>Export video</button>
            {renderUrl && <a className="btn" href={renderUrl} download="videocraft-export.mp4">Download video</a>}
          </div>
          {renderJobId && !renderUrl && <p className="muted">{/^(failed|cancelled)/.test(renderJobStatus) ? "Export " + renderJobStatus + ". Try exporting again after resolving the error above." : "Exporting… " + renderJobStatus + ". This takes roughly as long as the video itself."}</p>}
          {learned && <details className="card learned-panel"><summary>Learned from your edits</summary>
            <p className="small">{learned.summary}</p>
            <p className="small muted">{learned.samples} signals: {learned.counts.removed ?? 0} removed, {learned.counts.exported ?? 0} exported, {learned.counts.rejected ?? 0} from rejected proposals.</p>
            <button className="btn" onClick={resetLearned} disabled={busy || learned.samples === 0}>Reset what was learned</button>
          </details>}
        </section>
        <aside className="col narrow">{player}</aside>
      </main>
    </div>;
  }

  // ── Edit ────────────────────────────────────────────────────────────────────────────────
  const modePane = mode === "story" ? <section className="pane transcript" aria-label="Transcript">
      <div className="pane-head"><h2>Story</h2><span className="muted small">{formatClock(keptUs)} kept{mainVideo?.durationUs ? " of " + formatClock(mainVideo.durationUs) : ""}</span></div>
      {words.length === 0 ? <p className="muted pad">{transcribing ? "Listening to the video… the transcript appears here." : "No transcript yet."}</p> : <>
        <p className="muted small pad">Click a word, shift-click another to select the words between. Cut words are struck through.</p>
        <div className="words" onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }}>{segments.map((segment) => <p key={segment.id} className="para"><span className="mono time">{formatClock(segment.startUs)}</span>{segment.words.map((word) => { const index = words.indexOf(word); const isSel = selection ? index >= Math.min(selection.from, selection.to) && index <= Math.max(selection.from, selection.to) : false; return <span key={word.startUs + ":" + index} className={"word" + (kept[index] ? "" : " cut") + (isSel ? " sel" : "")} onClick={(event) => pickWord(index, event.shiftKey)}>{word.text} </span>; })}</p>)}</div>
        {selection && <div className="selection-bar" role="toolbar" aria-label="Selected words">
          <span className="small">“{selectionText.slice(0, 60)}{selectionText.length > 60 ? "…" : ""}”</span>
          {selectionKept.some(Boolean) && <button className="btn" onClick={cutSelection} disabled={busy}>Cut</button>}
          {selectionKept.some((k) => !k) && <button className="btn" onClick={restoreSelection} disabled={busy}>Bring back</button>}
          <button className="btn" onClick={() => addGraphic(selectionText.split(" ").slice(0, 6).join(" ").replace(/[.,;:!?]+$/, ""), "title")} disabled={busy || !selectionKept.some(Boolean)}>Title here</button>
          <button className="btn" onClick={() => { setMode("visuals"); }} disabled={busy}>Cutaway here</button>
          <button className="btn" onClick={() => { setMode("audio"); }} disabled={busy}>Sound here</button>
          <button className="btn" onClick={() => setSelection(null)}>Clear</button>
        </div>}
      </>}
    </section>
    : mode === "captions" ? <section className="pane" aria-label="Captions and text">
      <div className="pane-head"><h2>Captions &amp; text</h2></div>
      <div className="pad stack graphics-panel">
        <h3>Add text on screen</h3>
        <label>Type<select value={gfxKind} onChange={(event) => setGfxKind(event.target.value as "title" | "callout" | "lower-third")}><option value="title">Title</option><option value="callout">Callout</option><option value="lower-third">Name caption (name + role)</option></select></label>
        <label>{gfxKind === "lower-third" ? "Name" : "Text"}<input value={gfxText} maxLength={120} onChange={(event) => setGfxText(event.target.value)} /></label>
        {gfxKind !== "callout" && <label>{gfxKind === "lower-third" ? "Role" : "Second line"} (optional)<input value={gfxSubtitle} maxLength={120} onChange={(event) => setGfxSubtitle(event.target.value)} /></label>}
        {gfxKind !== "lower-third" && <label>Position<select value={gfxPosition} onChange={(event) => setGfxPosition(event.target.value as "top" | "center" | "bottom")}><option value="top">Top</option><option value="center">Centre</option><option value="bottom">Bottom</option></select></label>}
        <label>On screen for (seconds)<input type="number" min={0.5} max={60} step={0.5} value={gfxSeconds} onChange={(event) => setGfxSeconds(Math.max(0.5, Number(event.target.value) || 3))} /></label>
        <button className="btn" onClick={() => addGraphic()} disabled={busy || revision === 0 || !gfxText.trim()}>{selection ? "Add at the selected words" : "Add at the playhead"}</button>
        {graphicsClips.length > 0 && <ul className="item-list graphics-list">{graphicsClips.map((clip) => { const original = String(clip.transform?.text ?? ""); const draft = gfxDrafts[clip.id] ?? original; return <li key={clip.id}><span className="mono small">{formatSeconds(clip.timelineStartUs)}</span><input aria-label={"Text at " + formatSeconds(clip.timelineStartUs)} value={draft} maxLength={120} onChange={(event) => setGfxDrafts((current) => ({ ...current, [clip.id]: event.target.value }))} /><button className="btn" onClick={() => void applyEdit([{ type: "update-graphic", clipId: clip.id, text: draft.trim() }], "Text updated").then((ok) => { if (ok) setGfxDrafts((current) => { const { [clip.id]: _done, ...rest } = current; return rest; }); })} disabled={busy || !draft.trim() || draft.trim() === original}>Save</button><button className="btn" onClick={() => void applyEdit([{ type: "remove-clip", clipId: clip.id, reason: "Text removed" }], "Text removed")} disabled={busy}>Remove</button></li>; })}</ul>}
        <label className="checkbox"><input type="checkbox" checked={Boolean(progressClip)} disabled={busy || revision === 0} onChange={(event) => void applyEdit([{ type: "set-progress-bar", enabled: event.target.checked, color: gfxColor }], event.target.checked ? "Progress bar on" : "Progress bar off")} /> Progress bar across the top</label>
        <h3>Captions</h3>
        {captionCues.length === 0 ? <p className="muted small">No captions yet. Cutting with the director or bringing words back adds them; the check offers them for short videos.</p> : <ul className="item-list cue-list captions-panel">{captionCues.map((cue) => { const original = String(cue.transform?.text ?? ""); const draft = captionDrafts[cue.id] ?? original; return <li key={cue.id}><span className="mono small">{formatSeconds(cue.timelineStartUs)}</span><input aria-label={"Caption at " + formatSeconds(cue.timelineStartUs)} value={draft} onChange={(event) => setCaptionDrafts((current) => ({ ...current, [cue.id]: event.target.value }))} /><button className="btn" onClick={() => saveCaption(cue)} disabled={busy || revision === 0 || draft.trim() === original}>Save</button></li>; })}</ul>}
        {captionCues.length === 0 && words.length > 0 && segmentsFor && <button className="btn" onClick={() => void applyEdit(cueOps(words.filter((_, i) => kept[i]), segmentsFor), "Captions added")} disabled={busy || revision === 0}>Add captions for the cut</button>}
      </div>
    </section>
    : mode === "visuals" ? <section className="pane" aria-label="Visuals">
      <div className="pane-head"><h2>Visuals</h2></div>
      <div className="pad stack broll-panel effects-panel">
        <h3>Look</h3>
        <label>Look for the whole video<select value={wholeLook} disabled={busy || revision === 0} onChange={(event) => { if (event.target.value !== "mixed") void applyEdit([{ type: "set-look", look: event.target.value }], "Look: " + (LOOK_LABEL[event.target.value] ?? event.target.value)); }}>{wholeLook === "mixed" && <option value="mixed">Mixed (set per clip)</option>}{Object.entries(LOOK_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <p className="muted small">Zooms and transitions are set per clip: select a clip on the timeline.</p>
        <h3>Background</h3>
        <p className="muted small">Change what is behind you: you are cut out of the picture and kept in front.{selectedClip ? " Applies to the selected clip." : " Applies to the whole video (select a clip to change just that one)."}</p>
        <label>Behind me<select value={bgKind} onChange={(event) => setBgKind(event.target.value as typeof bgKind)}><option value="none">Original</option><option value="blur">Blurred</option><option value="color">A colour</option><option value="media">A photo or clip</option></select></label>
        {bgKind === "color" && <label>Colour<input type="color" value={bgColor} onChange={(event) => setBgColor(event.target.value)} /></label>}
        {bgKind === "media" && <label>Photo or clip<select value={bgAssetId} onChange={(event) => setBgAssetId(event.target.value)}><option value="">Choose (upload or add from Free stock below)</option>{brollAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.kind === "image" ? "Photo" : "Clip"} · {String(asset.metadata.filename ?? asset.id.slice(0, 8))}</option>)}</select></label>}
        {bgKind !== "none" && <>
          <label>Edge ({bgEdge === 0 ? "as found" : bgEdge > 0 ? "looser +" + bgEdge : "tighter " + bgEdge})<input type="range" min={-8} max={8} step={1} value={bgEdge} onChange={(event) => setBgEdge(Number(event.target.value))} /></label>
          <label>Softness ({bgFeather})<input type="range" min={0} max={12} step={1} value={bgFeather} onChange={(event) => setBgFeather(Number(event.target.value))} /></label>
        </>}
        <button className="btn" disabled={busy || revision === 0 || (bgKind === "media" && !bgAssetId)} onClick={() => void applyEdit([{ type: "set-background", ...(selectedClip ? { clipId: selectedClip.id } : {}), background: bgKind, ...(bgKind === "color" ? { color: bgColor } : {}), ...(bgKind === "media" ? { assetId: bgAssetId } : {}), ...(bgKind !== "none" ? { edge: bgEdge, feather: bgFeather } : {}) }], bgKind === "none" ? "Original background" : "Background changed" + (selectedClip ? " on this clip" : ""))}>{bgKind === "none" ? "Use the original background" : selectedClip ? "Change this clip's background" : "Change the background"}</button>
        <h3>Cutaways</h3>
        <label className="btn file-btn">Upload a photo or clip<input type="file" accept="image/*,video/*" aria-label="Upload a photo or clip" onChange={(event) => void uploadAsset(event, "media")} disabled={busy} /></label>
        <label>Cutaway media<select value={brollAssetId} onChange={(event) => setBrollAssetId(event.target.value)}><option value="">Choose a photo or clip</option>{brollAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.kind === "image" ? "Photo" : "Clip"} · {String(asset.metadata.filename ?? asset.id.slice(0, 8))}</option>)}</select></label>
        <label>On screen for (seconds)<input type="number" min={0.5} max={60} step={0.5} value={brollSeconds} onChange={(event) => setBrollSeconds(Math.max(0.5, Number(event.target.value) || 3))} /></label>
        <label>Style<select value={brollMode} onChange={(event) => setBrollMode(event.target.value as "full" | "pip" | "behind")}><option value="full">Full frame</option><option value="pip">Corner inset</option><option value="behind">Behind me</option></select></label>
        <button className="btn" onClick={() => addBroll()} disabled={busy || revision === 0 || !brollAssetId}>{selection ? "Add at the selected words" : "Add at the playhead"}</button>
        <h3>Free stock</h3>
        <StockSearch projectId={projectId} request={request} disabled={busy || revision === 0} orientation={(PLATFORMS[platform]?.width ?? 9) < (PLATFORMS[platform]?.height ?? 16) ? "portrait" : PLATFORMS[platform]?.width === PLATFORMS[platform]?.height ? "square" : "landscape"}
          onUse={(asset) => { setAssets((current) => [...current.filter((a) => a.id !== asset.id), asset as unknown as Asset]); setBrollAssetId(asset.id); addBroll(asset.id); }} />
        {brolls.length > 0 && <ul className="item-list broll-list">{brolls.map((clip) => <li key={clip.id}><span>{formatSeconds(clip.timelineStartUs)}–{formatSeconds(clip.timelineEndUs)} · {assetName(clip.assetId)} · {clip.transform?.mode === "pip" ? "inset" : clip.transform?.mode === "behind" ? "behind you" : "full"}</span><button className="btn" onClick={() => void applyEdit([{ type: "remove-clip", clipId: clip.id, reason: "Cutaway removed" }], "Cutaway removed")} disabled={busy}>Remove</button></li>)}</ul>}
      </div>
    </section>
    : mode === "audio" ? <section className="pane" aria-label="Audio">
      <div className="pane-head"><h2>Audio</h2></div>
      <div className="pad stack music-panel">
        {(musicClip || sfxClips.length > 0 || voiceovers.length > 0) && <>
          <h3>Levels</h3>
          <p className="muted small">Drag and let go: the change is saved and you hear it in the preview.</p>
          {musicClip && <Level label="Music" valueDb={Number(musicClip.transform?.volumeDb ?? -20)} disabled={busy} onCommit={(db) => void applyEdit([{ type: "set-volume", role: "music", volumeDb: db }], "Music volume " + db + " dB")} />}
          {sfxClips.length > 0 && <Level label={"Sound effects (" + sfxClips.length + ")"} valueDb={Math.round(sfxClips.reduce((sum, clip) => sum + Number(clip.transform?.volumeDb ?? -18), 0) / sfxClips.length)} disabled={busy} onCommit={(db) => void applyEdit([{ type: "set-volume", role: "sfx", volumeDb: db }], "Sound effects volume " + db + " dB")} />}
          {voiceovers.length > 0 && <Level label="Voice-overs" valueDb={Math.round(voiceovers.reduce((sum, clip) => sum + Number(clip.transform?.volumeDb ?? 0), 0) / voiceovers.length)} min={-20} disabled={busy} onCommit={(db) => void applyEdit([{ type: "set-volume", role: "voiceover", volumeDb: db }], "Voice-over volume " + db + " dB")} />}
          {sfxClips.length > 0 && <button className="btn" onClick={() => void applyEdit(sfxClips.map((clip) => ({ type: "remove-clip", clipId: clip.id, reason: "Sound effects removed" })), "All sound effects removed")} disabled={busy}>Remove all sound effects</button>}
        </>}
        <h3>Music</h3>
        {musicClip ? <p className="small">Playing <strong>{musicName}</strong>{(() => { const meta = assets.find((asset) => asset.id === musicClip.assetId)?.metadata; return meta?.generated ? " (" + String(meta.mood) + ", " + String(meta.key) + ", " + String(meta.bpm) + " BPM)" : ""; })()} at {String(musicClip.transform?.volumeDb)} dB{musicClip.transform?.duck === false ? "" : ", lowered while people speak"}.</p> : <p className="muted small">Music fades in and out and dips while people speak.</p>}
        <label>Mood<select value={musicMood} onChange={(event) => setMusicMood(event.target.value)}><option value="auto">Match my description</option><option value="upbeat">Upbeat</option><option value="calm">Calm</option><option value="inspiring">Inspiring</option><option value="serious">Serious</option><option value="playful">Playful</option></select></label>
        <button className="btn" onClick={generateMusicBed} disabled={busy || revision === 0}>{musicClip && assets.find((asset) => asset.id === musicClip.assetId)?.metadata.generated ? "Try different music" : "Generate matching music"}</button>
        <label className="btn file-btn">Upload your own track<input type="file" accept="audio/*" aria-label="Upload a music track" onChange={(event) => void uploadAsset(event, "media")} disabled={busy} /></label>
        {audioAssets.length > 0 && <label>Music track<select value={musicAssetId} onChange={(event) => setMusicAssetId(event.target.value)}><option value="">Choose a track</option>{audioAssets.map((asset) => <option key={asset.id} value={asset.id}>{String(asset.metadata.filename ?? asset.id.slice(0, 8))}</option>)}</select></label>}
        {!musicClip && <label>Music volume ({musicVolume} dB)<input type="range" min={-36} max={-4} step={1} value={musicVolume} onChange={(event) => setMusicVolume(Number(event.target.value))} /></label>}
        <label className="checkbox"><input type="checkbox" checked={musicDuck} onChange={(event) => setMusicDuck(event.target.checked)} /> Lower it while people speak</label>
        {audioAssets.length > 0 && <button className="btn" onClick={() => void applyEdit([{ type: "set-music", assetId: musicAssetId, volumeDb: musicClip ? Number(musicClip.transform?.volumeDb ?? musicVolume) : musicVolume, duck: musicDuck }], "Music set")} disabled={busy || revision === 0 || !musicAssetId}>{musicClip ? "Use this track instead" : "Use this track"}</button>}
        {musicClip && <button className="btn" onClick={() => void applyEdit([{ type: "clear-music" }], "Music removed")} disabled={busy}>Remove music</button>}
        <h3>Voice-over</h3>
        <VoiceOver projectId={projectId} apiBase={API} token={token} request={request} disabled={busy || revision === 0}
          onRecording={(active) => { if (active) recordAnchor.current = anchorPoint(); const live = liveRef.current; if (!live) return; live.setMuted(active); if (active) live.play(); else live.pause(); }}
          onAdd={(asset, options) => {
            setAssets((current) => [...current.filter((a) => a.id !== asset.id), asset as unknown as Asset]);
            // A recording starts where the playhead was when recording began.
            const anchor = recordAnchor.current ?? anchorPoint(); recordAnchor.current = undefined;
            if (!anchor) { setStatus("Add a video clip first"); return; }
            void applyEdit([{ type: "add-voiceover", assetId: asset.id, anchorAssetId: anchor.anchorAssetId, anchorSourceUs: anchor.anchorSourceUs, durationUs: Math.max(200_000, Number(asset.durationUs ?? 0) || 3_000_000), volumeDb: options.volumeDb, duck: options.duck }], "Voice-over added " + anchor.where);
          }} />
        {voiceovers.length > 0 && <ul className="item-list">{voiceovers.map((clip) => <li key={clip.id}><span>{formatSeconds(clip.timelineStartUs)}–{formatSeconds(clip.timelineEndUs)} · {assetName(clip.assetId)}</span><button className="btn" onClick={() => void applyEdit([{ type: "remove-clip", clipId: clip.id, reason: "Voice-over removed" }], "Voice-over removed")} disabled={busy}>Remove</button></li>)}</ul>}
        <h3>Sound effects</h3>
        <label>Sound effect<select value={sfxKind} onChange={(event) => setSfxKind(event.target.value)}>{Object.entries(SFX_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <button className="btn" onClick={addSoundEffect} disabled={busy || revision === 0}>{selection ? "Add at the selected words" : "Add sound at the playhead"}</button>
        {sfxClips.length > 0 && <ul className="item-list">{sfxClips.map((clip) => <li key={clip.id}><span>{formatSeconds(clip.timelineStartUs)} · {SFX_LABEL[String(clip.transform?.kind)] ?? "Sound"}</span><button className="btn" onClick={() => void applyEdit([{ type: "remove-clip", clipId: clip.id, reason: "Sound removed" }], "Sound removed")} disabled={busy}>Remove</button></li>)}</ul>}
      </div>
    </section>
    : <section className="pane" aria-label="Brand">
      <div className="pane-head"><h2>Brand</h2></div>
      <div className="pad stack">
        <label>Accent colour for titles and the progress bar<input type="color" value={gfxColor} onChange={(event) => setGfxColor(event.target.value)} /></label>
        <p className="muted small">New titles, callouts and name captions use this colour. Saved brand kits (logo, colours, fonts) are coming next.</p>
      </div>
    </section>;

  const inspector = selected ? <aside className="inspector" aria-label="Selected">
    <div className="row-between"><h2>{selected.kind === "video" ? "Selected clip" : selected.kind === "caption" ? "Caption" : selected.clip.transform?.role === "graphic" ? "Text on screen" : selected.clip.transform?.role === "broll" ? "Cutaway" : selected.clip.transform?.role === "sfx" ? "Sound effect" : selected.clip.transform?.role === "voiceover" ? "Voice-over" : selected.clip.transform?.role === "music" ? "Music" : "Selected"}</h2><button className="btn icon" aria-label="Close" onClick={() => setSelectedClipId("")}>×</button></div>
    <p className="small"><strong>{clipLabel(selected.kind, selected.clip)}</strong></p>
    <p className="mono small muted">{formatSeconds(selected.clip.timelineStartUs)}–{formatSeconds(selected.clip.timelineEndUs)} in the edit</p>
    {selectedClip ? <div className="clip-panel stack" aria-label="Selected clip">
      {selectedClip.reason && <p className="small muted">{selectedClip.reason}</p>}
      <div className="clip-actions">
        <button className="btn" onClick={() => nudgeSelectedClip(-1)} disabled={busy}>Move earlier</button>
        <button className="btn" onClick={() => nudgeSelectedClip(1)} disabled={busy}>Move later</button>
        <button className="btn" onClick={() => trimSelectedClip(500_000, 0)} disabled={busy}>Trim start +0.5s</button>
        <button className="btn" onClick={() => trimSelectedClip(-500_000, 0)} disabled={busy}>Start −0.5s</button>
        <button className="btn" onClick={() => trimSelectedClip(0, -500_000)} disabled={busy}>Trim end −0.5s</button>
        <button className="btn" onClick={() => trimSelectedClip(0, 500_000)} disabled={busy}>End +0.5s</button>
        {sourceUrl && <><button className="btn" onClick={() => trimToPlayhead("start")} disabled={busy}>Start at playhead</button><button className="btn" onClick={() => trimToPlayhead("end")} disabled={busy}>End at playhead</button><button className="btn" onClick={playSelectedClip}>Play clip</button></>}
      </div>
      <div className="clip-effects stack">
        <label>Zoom<select value={String(selectedClip.transform?.zoom ?? "none")} disabled={busy} onChange={(event) => void applyEdit([{ type: "set-clip-effects", clipId: selectedClip.id, zoom: event.target.value }], "Zoom: " + (ZOOM_LABEL[event.target.value] ?? event.target.value))}>{Object.entries(ZOOM_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>Into this clip<select value={String(selectedClip.transform?.transitionIn ?? "cut")} disabled={busy} onChange={(event) => void applyEdit([{ type: "set-clip-effects", clipId: selectedClip.id, transitionIn: event.target.value }], "Transition: " + (TRANSITION_LABEL[event.target.value] ?? event.target.value))}>{Object.entries(TRANSITION_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {selectedClip.transform?.transitionIn && selectedClip.transform.transitionIn !== "cut" && <label>Transition length ({Number(selectedClip.transform?.transitionSeconds ?? (["dip-black", "dip-white"].includes(String(selectedClip.transform.transitionIn)) ? 0.5 : selectedClip.transform.transitionIn === "flash" ? 0.12 : 0.5)).toFixed(2)} s)<input type="range" min={0.1} max={2} step={0.05} defaultValue={Number(selectedClip.transform?.transitionSeconds ?? 0.5)} key={selectedClip.id + String(selectedClip.transform?.transitionSeconds)} disabled={busy} onPointerUp={(event) => void applyEdit([{ type: "set-clip-effects", clipId: selectedClip.id, transitionSeconds: Number((event.target as HTMLInputElement).value) }], "Transition length " + Number((event.target as HTMLInputElement).value).toFixed(2) + " s")} onKeyUp={(event) => void applyEdit([{ type: "set-clip-effects", clipId: selectedClip.id, transitionSeconds: Number((event.target as HTMLInputElement).value) }], "Transition length " + Number((event.target as HTMLInputElement).value).toFixed(2) + " s")} /></label>}
        {selectedClip.id === videoClips.at(-1)?.id && <label>Ending<select value={String(selectedClip.transform?.transitionOut ?? "cut")} disabled={busy} onChange={(event) => void applyEdit([{ type: "set-clip-effects", clipId: selectedClip.id, transitionOut: event.target.value }], "Ending: " + (TRANSITION_LABEL[event.target.value] ?? event.target.value))}><option value="cut">Hard end</option><option value="dip-black">Fade to black</option><option value="dip-white">Fade to white</option></select></label>}
        <label>Look<select value={String(selectedClip.transform?.look ?? "none")} disabled={busy} onChange={(event) => void applyEdit([{ type: "set-clip-effects", clipId: selectedClip.id, look: event.target.value }], "Clip look: " + (LOOK_LABEL[event.target.value] ?? event.target.value))}>{Object.entries(LOOK_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      </div>
      <button className="btn danger-outline" onClick={() => removeSelectedClip()} disabled={busy}>Remove clip</button>
    </div> : <>
      {selected.kind === "audio" && <Level label="Volume" valueDb={Number(selected.clip.transform?.volumeDb ?? (selected.clip.transform?.role === "music" ? -20 : selected.clip.transform?.role === "sfx" ? -18 : 0))} disabled={busy} onCommit={(db) => void applyEdit([{ type: "set-volume", clipId: selected.clip.id, volumeDb: db }], "Volume " + db + " dB")} />}
      {selected.kind !== "caption" && selected.clip.transform?.role !== "music" && selected.clip.transform?.role !== "progress" ? <button className="btn danger-outline" onClick={() => removeSelectedClip()} disabled={busy}>Remove</button> : null}
    </>}
  </aside> : null;

  return <div className="app-shell">{projectHeader}
    <main className="editor">
      <nav aria-label="Editing modes" className="mode-rail">{MODES.map((item) => <button key={item.id} type="button" className={"mode" + (mode === item.id ? " on" : "")} aria-pressed={mode === item.id} onClick={() => { if (item.id === "review") { setScreen("check"); if (!check || check.revision !== revision) void runCheck(); } else setMode(item.id); }}><ModeIcon id={item.id} />{item.label}{item.id === "review" && check && check.revision === revision && check.issues.some((issue) => issue.severity === "fix") ? <span className="badge-dot" aria-label="has findings" /> : null}</button>)}</nav>
      <div className="work">
        <div className="work-top">
          {modePane}
          <section className="pane preview-pane" aria-label="Preview">{player}
            <form className="ask" onSubmit={(event) => { event.preventDefault(); void askDirector(); }}>
              <label htmlFor="ask" className="ask-label">Ask</label>
              <input id="ask" value={askText} maxLength={500} placeholder="Change anything… “make it shorter”, “warmer look”, “remove the part about pricing”" onChange={(event) => setAskText(event.target.value)} disabled={busy || revision === 0} />
              <button type="submit" className="primary" disabled={busy || revision === 0 || askText.trim().length < 3}>Go</button>
            </form>
            {askPlan && <div className="card ask-result" aria-label="Suggested changes">
              <div className="row-between"><strong>{askPlan.summary}</strong><span className="tag">{askPlan.source === "ai" ? "AI director" : "Built-in director"}</span></div>
              {askPlan.note && <p className="note">{askPlan.note}</p>}
              <ul className="suggestion-list">{askPlan.suggestions.map((item) => <li key={item.id} className={"suggestion" + (askPicked[item.id] || item.kind === "advice" ? "" : " off")}>
                {item.kind !== "advice" && <input type="checkbox" id={"a-" + item.id} checked={Boolean(askPicked[item.id])} onChange={(event) => setAskPicked((current) => ({ ...current, [item.id]: event.target.checked }))} />}
                <div className="suggestion-body"><label htmlFor={"a-" + item.id}><strong>{item.title}</strong></label><span className="small what">{describeSuggestion(item)}</span>{item.pick && <span className="stock-pick"><img src={item.pick.thumbUrl} alt={"Stock: " + (item.query ?? "")} loading="lazy" /><span className="muted small">{item.pick.credit ?? "Free stock"}</span></span>}</div>
              </li>)}</ul>
              <div className="actions">
                {askPlan.suggestions.some((item) => item.kind !== "advice") && <button className="primary" onClick={applyAsk} disabled={busy || !askPlan.suggestions.some((item) => askPicked[item.id] && item.kind !== "advice")}>Apply</button>}
                <button className="btn" onClick={() => setAskPlan(null)} disabled={busy}>Dismiss</button>
              </div>
            </div>}
          </section>
          {inspector}
        </div>
        <section className="timeline" aria-label="Timeline">
          <div className="row-between"><h2>Timeline</h2><span className="muted small">{formatClock(timeline.durationUs)} · select anything to edit it</span></div>
          <div className="ruler" aria-hidden="true"><span className="ruler-gutter" /><div className="ruler-lane">{rulerTicks(timeline.durationUs).map((t) => <span key={t} style={{ left: (t / Math.max(1, timeline.durationUs / 1e6)) * 100 + "%" }}>{String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(Math.round(t % 60)).padStart(2, "0")}</span>)}</div></div>
          <div className="track-list" style={{ position: "relative" }}>
            {videoClips.length > 0 && <span className="playhead" aria-hidden="true" style={{ left: "calc(76px + (100% - 76px) * " + (liveUs / Math.max(1, timeline.durationUs)).toFixed(5) + ")" }} />}
            {videoClips.length === 0 && <div className="empty-state">Nothing on the timeline yet. Make the first cut, or choose Edit it myself.</div>}
            {lanes.map((lane) => <div className="track" key={lane.name}><div className="track-label">{lane.name}</div><div className="track-lane" onClick={(event) => { if (event.target !== event.currentTarget) return; const box = event.currentTarget.getBoundingClientRect(); setPreviewMode("edit"); liveRef.current?.seek(((event.clientX - box.left) / box.width) * timeline.durationUs); }}>{lane.clips.map((clip) => <button type="button" className={"clip lane-" + lane.name.toLowerCase() + (clip.transform?.role === "progress" ? " progress" : "") + (selectedClipId === clip.id ? " selected" : "")} key={clip.id} style={{ left: (clip.timelineStartUs / Math.max(1, timeline.durationUs)) * 100 + "%", width: ((clip.timelineEndUs - clip.timelineStartUs) / Math.max(1, timeline.durationUs)) * 100 + "%" }} title={clipLabel(lane.kind, clip) + " · " + formatSeconds(clip.timelineEndUs - clip.timelineStartUs)} aria-label={clipLabel(lane.kind, clip) + ", " + formatSeconds(clip.sourceEndUs - clip.sourceStartUs)} aria-pressed={selectedClipId === clip.id} onClick={() => setSelectedClipId(clip.id)} onKeyDown={(event) => handleClipKeyDown(event, clip, lane.kind)}><strong>{clipLabel(lane.kind, clip)}</strong>{lane.kind === "video" && <small>{formatSeconds(clip.sourceEndUs - clip.sourceStartUs)}</small>}</button>)}</div></div>)}
          </div>
        </section>
      </div>
    </main>
  </div>;
}

function ModeIcon({ id }: { id: Mode }) {
  const p = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, "aria-hidden": true };
  if (id === "story") return <svg {...p}><path d="M4 6h16M4 12h10M4 18h13" /></svg>;
  if (id === "captions") return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 15h4M13 15h4" /></svg>;
  if (id === "visuals") return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></svg>;
  if (id === "audio") return <svg {...p}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>;
  if (id === "brand") return <svg {...p}><path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z" /></svg>;
  return <svg {...p}><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>;
}

/** What a plan suggestion changes, in plain words. */
function describeSuggestion(item: Suggestion): string {
  if (item.kind === "cut" && item.segments) return item.segments.length + " part" + (item.segments.length === 1 ? "" : "s") + ", " + Math.round(item.segments.reduce((sum, seg) => sum + seg.endS - seg.startS, 0)) + " seconds: " + item.segments.map((seg) => formatClock(seg.startS * 1e6) + "–" + formatClock(seg.endS * 1e6)).join(", ");
  if (item.kind === "music") return "Mood: " + (item.mood ?? "") + ", lowered while people speak";
  if (item.kind === "platform") return PLATFORMS[item.platform ?? ""]?.label ?? "";
  if (item.kind === "look" || item.kind === "background" || item.kind === "remove" || item.kind === "color" || item.kind === "captions") return "Whole video";
  if (item.kind === "volume" && typeof item.changeDb === "number") return (item.changeDb > 0 ? "+" : "") + item.changeDb + " dB from where it is now";
  if (item.kind === "stock") return "Free stock · " + (item.mode === "behind" ? "behind you" : item.mode === "pip" ? "corner" : "full screen") + (typeof item.atS === "number" ? " · at " + formatClock(item.atS * 1e6) + " of the original" : "");
  if (item.kind === "voiceover" && item.text) return (item.afterVideo ? "After the video, on an end card: " : "") + "“" + item.text.slice(0, 120) + (item.text.length > 120 ? "…" : "") + "”";
  if (typeof item.atS === "number" && item.kind !== "advice") return "At " + formatClock(item.atS * 1e6) + " of the original" + (item.durationS ? ", for " + item.durationS.toFixed(1) + " s" : "");
  return item.kind === "advice" ? item.reason : "";
}

/** One entry per highlight: clips cut from one highlight (pauses removed) share its reason. */
function groupHighlights(operations: Operation[]): Array<{ startUs: number; endUs: number; score?: number; reason: string; parts: number }> {
  const groups: Array<{ startUs: number; endUs: number; score?: number; reason: string; parts: number }> = [];
  for (const operation of operations) {
    if (operation.type !== "insert-clip") continue;
    const reason = String(operation.reason ?? "");
    const last = groups[groups.length - 1];
    if (last && last.reason === reason) { last.endUs = Math.max(last.endUs, operation.sourceEndUs ?? last.endUs); last.parts += 1; continue; }
    groups.push({ startUs: operation.sourceStartUs ?? 0, endUs: operation.sourceEndUs ?? 0, ...(typeof operation.score === "number" ? { score: operation.score } : {}), reason, parts: 1 });
  }
  return groups;
}

/** Plain-language labels for evidence references (raw keys are kept for the API, not shown). */
function evidenceLabel(item: Evidence): { source: string; reference: string } {
  const source = item.source === "user" ? "From you" : item.source === "transcript" ? "What was said" : "VideoCraft";
  const ref = item.reference;
  const reference = ref === "tailoring-profile.intent" ? "Your goal" : ref === "tailoring-profile.audience" ? "Your audience" : ref === "tailoring-profile.channel" ? "Platform"
    : ref.startsWith("highlight-score:") ? "Score for highlight " + ref.split(":")[1] : ref === "learned-preferences" ? "Learned from your edits"
    : ref.startsWith("llm-rerank") ? "AI judge" : item.source === "transcript" ? "Transcript" : ref;
  return { source, reference };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Something went wrong"; }
function formatSeconds(microseconds: number): string { return (microseconds / 1_000_000).toFixed(1) + "s"; }
function formatClock(microseconds: number): string { const s = Math.max(0, Math.round(microseconds / 1e6)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
