import { useEffect, useRef, useState } from "react";

/**
 * Voice-over: record yourself over the edit (the preview plays silently while you speak), or type a script and
 * pick a voice. Either way the recording is stored as an audio asset and placed at the playhead.
 */
type Asset = { id: string; kind: string; durationUs?: number; metadata: Record<string, string | number | boolean> };
type Props = {
  projectId: string;
  apiBase: string;
  token: string;
  request(path: string, init?: RequestInit): Promise<any>;
  disabled: boolean;
  initialScript?: string;
  placement?: "story" | "playhead";
  onWorking?(working: boolean): void;
  onScriptChange?(script: string): void;
  /** Start / stop the live preview while recording (silently, so the mic hears only you). */
  onRecording(active: boolean): void;
  /** Place the stored recording on the edit. */
  onAdd(asset: Asset, options: { volumeDb: number; duck: boolean }): void;
};
const VOICE_LABEL: Record<string, string> = { marin: "Marin (natural, female)", cedar: "Cedar (natural, male)", verse: "Verse (expressive)", alloy: "Alloy (neutral)", ash: "Ash (clear, male)", ballad: "Ballad (soft)", coral: "Coral (bright, female)", echo: "Echo (calm, male)", fable: "Fable (storyteller)", nova: "Nova (warm, female)", onyx: "Onyx (deep, male)", sage: "Sage (gentle)", shimmer: "Shimmer (light, female)" };

export function VoiceOver({ projectId, apiBase, token, request, disabled, initialScript = "", placement = "playhead", onWorking, onScriptChange, onRecording, onAdd }: Props) {
  const [voices, setVoices] = useState<string[]>([]);
  const [script, setScript] = useState(initialScript);
  const [voice, setVoice] = useState("marin");
  const [style, setStyle] = useState("");
  const [duck, setDuck] = useState(true);
  const [volumeDb, setVolumeDb] = useState(0);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [working, setWorking] = useState("");
  const [note, setNote] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const started = useRef(0);

  useEffect(() => { setScript(initialScript); }, [initialScript]);
  useEffect(() => { onWorking?.(Boolean(working || recording)); return () => onWorking?.(false); }, [working, recording]);
  useEffect(() => () => { const rec = recorder.current; if (rec) { rec.onstop = null; rec.stream.getTracks().forEach(track => track.stop()); if (rec.state !== "inactive") rec.stop(); } }, []);
  useEffect(() => { request("/v1/projects/" + projectId + "/voiceover/voices").then((r) => setVoices(r.voices ?? [])).catch(() => setVoices([])); }, [projectId]);
  useEffect(() => { if (!recording) return; const t = setInterval(() => setSeconds((Date.now() - started.current) / 1000), 200); return () => clearInterval(t); }, [recording]);

  async function upload(blob: Blob, name: string): Promise<Asset> {
    const form = new FormData(); form.append("file", new File([blob], name, { type: blob.type || "audio/webm" }));
    const body = await request("/v1/projects/" + projectId + "/assets/upload?kind=audio", { method: "POST", body: form });
    return body.asset;
  }

  async function start() {
    setNote("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setNote("Recording is unavailable in this browser. Use AI narration or upload a recording."); return; }
    setWorking("microphone");
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch { setWorking(""); setNote("Allow the microphone to record a voice-over."); return; }
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
    let rec: MediaRecorder;
    try { rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
    catch { stream.getTracks().forEach(track => track.stop()); setWorking(""); setNote("This browser could not start recording. Upload a recording instead."); return; }
    const chunks: Blob[] = [];
    rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      onRecording(false); setRecording(false);
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if ((Date.now() - started.current) < 500 || blob.size < 1000) { setNote("That was too short to keep."); return; }
      setWorking("upload");
      try { const asset = await upload(blob, "Voice-over " + new Date().toLocaleTimeString() + (blob.type.includes("mp4") ? ".m4a" : ".webm")); onAdd(asset, { volumeDb, duck }); setNote("Voice-over added."); }
      catch (caught) { setNote(caught instanceof Error ? caught.message : "Could not save the recording"); }
      finally { setWorking(""); }
    };
    recorder.current = rec; started.current = Date.now(); setSeconds(0);
    try { rec.start(); setRecording(true); onRecording(true); setWorking(""); }
    catch { recorder.current = null; stream.getTracks().forEach(track => track.stop()); setWorking(""); setNote("Recording could not start. Try again or upload a recording."); }
  }
  function stop() { recorder.current?.stop(); recorder.current = null; }

  async function speak() {
    setWorking("speak"); setNote("");
    try {
      const result = await request("/v1/projects/" + projectId + "/voiceover/speech", { method: "POST", body: JSON.stringify({ text: script, voice, ...(style.trim() ? { style } : {}) }) });
      onAdd(result.asset, { volumeDb, duck }); setNote(placement === "story" ? "Narration ready. Listen before assembling." : "Voice-over added."); if (placement !== "story") setScript("");
    } catch (caught) { setNote(caught instanceof Error ? caught.message : "Could not make the voice"); }
    finally { setWorking(""); }
  }

  return <div className="stack voiceover">
    <p className="muted small">{placement === "story" ? "Record a complete narration or make an AI voice from the script. Listen before assembling." : "Starts at the playhead (or the selected words). The video’s own sound dips while it plays."}</p>
    {recording
      ? <button type="button" className="btn primary rec" onClick={stop}>■ Stop recording · {seconds.toFixed(1)}s</button>
      : <button type="button" className="btn" onClick={() => void start()} disabled={disabled || working !== ""}>● Record my voice</button>}
    {voices.length > 0 && <>
      <label>Or type what to say<textarea rows={3} maxLength={3000} value={script} onChange={(event) => { setScript(event.target.value); onScriptChange?.(event.target.value); }} placeholder="The words to read out" /></label>
      <div className="row-2">
        <label>Voice<select value={voice} onChange={(event) => setVoice(event.target.value)}>{voices.map((v) => <option key={v} value={v}>{VOICE_LABEL[v] ?? v}</option>)}</select></label>
        <label>Delivery<input value={style} maxLength={200} onChange={(event) => setStyle(event.target.value)} placeholder="e.g. upbeat, calm" /></label>
      </div>
      <button type="button" className="btn" onClick={() => void speak()} disabled={disabled || working !== "" || !script.trim()}>{working === "speak" ? "Making the voice…" : "Add this voice-over"}</button>
    </>}
    {placement !== "story" && <><label>Voice-over volume ({volumeDb > 0 ? "+" : ""}{volumeDb} dB)<input type="range" min={-12} max={6} step={1} value={volumeDb} onChange={(event) => setVolumeDb(Number(event.target.value))} /></label>
    <label className="checkbox"><input type="checkbox" checked={duck} onChange={(event) => setDuck(event.target.checked)} /> Lower the video's sound under it</label></>}
    {working === "upload" && <p className="muted small" role="status">Saving the recording…</p>}
    {note && <p className="muted small" role="status">{note}</p>}
  </div>;
}
