import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegCommandPlanner, FfmpegProcess, PLATFORM_PRESETS, presetForChannel } from "../dist/index.js";

const settings = { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 };
const revision = (clips, extraTracks = []) => ({ projectId: "p", revision: 1, timeline: { durationUs: clips.reduce((n, c) => n + (c.sourceEndUs - c.sourceStartUs), 0), tracks: [{ id: "v", kind: "video", clips }, ...extraTracks] }, acceptedProposalIds: [], createdAt: "", createdBy: "u" });
const clip = (id, s, e, t) => ({ id, assetId: "asset", sourceStartUs: s, sourceEndUs: e, timelineStartUs: t, timelineEndUs: t + e - s });

test("plan uses argv without a shell and rounds odd dimensions to even", async () => {
  const planner = new FfmpegCommandPlanner({ resolve: async () => "/media/source.mp4" });
  const plan = await planner.plan(revision([clip("c", 0, 5_000_000, 0)]), { ...settings, width: 1281, height: 721 }, "/renders/output.mp4");
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.match(graph, /scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720/);
  assert.equal(plan.args.filter((a) => a === "-i").length, 1);
  assert.equal(plan.args.includes("/media/source.mp4"), true);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("-ss"), plan.args.indexOf("-ss") + 4), ["-ss", "0.000000", "-t", "5.000000"]);
});

test("multiple clips each get their own seeked input and are concatenated in timeline order", async () => {
  const planner = new FfmpegCommandPlanner({ resolve: async () => "/media/source.mp4", hasAudio: async () => true });
  const plan = await planner.plan(revision([clip("b", 8_000_000, 9_000_000, 5_000_000), clip("a", 1_000_000, 3_000_000, 0)]), settings, "/renders/o.mp4");
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.equal(plan.args.filter((a) => a === "-i").length, 2);
  const seeks = plan.args.flatMap((a, i) => (a === "-ss" ? [plan.args[i + 1]] : []));
  assert.deepEqual(seeks, ["1.000000", "8.000000"]);
  assert.match(graph, /concat=n=2:v=1:a=1\[vcat\]\[acat\]/);
});

test("cover fit crops for vertical output and captions are written as ASS", async () => {
  const planner = new FfmpegCommandPlanner({ resolve: async () => "/media/source.mp4" });
  const captions = { id: "c", kind: "caption", clips: [{ id: "q", assetId: "asset", sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000, transform: { text: "hello there", wordDurationsCs: "100,100" } }] };
  const plan = await planner.plan(revision([clip("c", 0, 5_000_000, 0)], [captions]), { ...PLATFORM_PRESETS.tiktok.settings }, "/renders/o.mp4");
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.match(graph, /force_original_aspect_ratio=increase,crop=1080:1920/);
  assert.match(graph, /ass=filename='\/renders\/o\.mp4\.captions\.ass'/);
  assert.equal(plan.files.length, 1);
  assert.match(plan.files[0].content, /HELLO/);
});

test("rejects empty timelines and unsafe caption paths", async () => {
  const planner = new FfmpegCommandPlanner({ resolve: async () => "/m.mp4" });
  await assert.rejects(() => planner.plan(revision([]), settings, "/o.mp4"), /no video clips/);
  const captions = { id: "c", kind: "caption", clips: [{ id: "q", assetId: "asset", sourceStartUs: 0, sourceEndUs: 1_000_000, timelineStartUs: 0, timelineEndUs: 1_000_000, transform: { text: "x" } }] };
  await assert.rejects(() => planner.plan(revision([clip("c", 0, 5_000_000, 0)], [captions]), settings, "/o'x.mp4"), /Invalid caption path/);
});

test("presets map channels to platform formats", () => {
  assert.equal(presetForChannel("short-form").settings.height, 1920);
  assert.equal(presetForChannel("youtube").settings.width, 1920);
  assert.equal(presetForChannel("something-else").id, "web");
});

test("real ffmpeg: renders a playable 9:16 video with joined clips, audio and burned-in captions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-render-"));
  try {
    const source = join(dir, "source.mp4");
    // 10s, 640x360 test pattern with a tone; changes pitch at 5s so cuts are audible/identifiable.
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=10", "-f", "lavfi", "-i", "sine=frequency=330:duration=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
    const planner = new FfmpegCommandPlanner({ resolve: async () => source, hasAudio: async () => true });
    const captions = { id: "cap", kind: "caption", clips: [{ id: "q1", assetId: "asset", sourceStartUs: 0, sourceEndUs: 1_500_000, timelineStartUs: 0, timelineEndUs: 1_500_000, transform: { text: "first clip words", wordDurationsCs: "50,50,50" } }] };
    const rev = revision([clip("a", 1_000_000, 3_000_000, 0), clip("b", 6_000_000, 8_500_000, 2_000_000)], [captions]);
    const out = join(dir, "out.mp4");
    const plan = await planner.plan(rev, PLATFORM_PRESETS.tiktok.settings, out);
    await new FfmpegProcess().run(plan);
    assert.equal(existsSync(out), true);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", out]).toString());
    const v = probe.streams.find((s) => s.codec_type === "video");
    const a = probe.streams.find((s) => s.codec_type === "audio");
    assert.deepEqual([v.width, v.height], [1080, 1920]);
    assert.ok(a, "audio stream present");
    assert.ok(Math.abs(Number(probe.format.duration) - 4.5) < 0.2, "duration " + probe.format.duration);
    // Full decode proves the file is playable end to end.
    execFileSync("ffmpeg", ["-v", "error", "-i", out, "-f", "null", "-"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cover crop follows the detected subject, a manual focus wins, and weak detections are ignored", async () => {
  const cover = { ...PLATFORM_PRESETS.tiktok.settings };
  const graphOf = async (resolver, c = clip("c", 0, 5_000_000, 0)) => {
    const plan = await new FfmpegCommandPlanner({ resolve: async () => "/media/s.mp4", ...resolver }).plan(revision([c]), cover, "/r/o.mp4");
    return plan.args[plan.args.indexOf("-filter_complex") + 1];
  };
  assert.match(await graphOf({ focus: async () => ({ x: 0.8, y: 0.4, confidence: 0.9 }) }), /crop=1080:1920:x='min\(max\(iw\*0\.8000-1080\/2,0\),iw-1080\)'/);
  assert.match(await graphOf({ focus: async () => ({ x: 0.8, y: 0.4, confidence: 0.1 }) }), /crop=1080:1920,fps/);
  assert.match(await graphOf({ focus: async () => ({ x: 0.8, y: 0.4, confidence: 0.9 }) }, { ...clip("c", 0, 5_000_000, 0), transform: { focusX: 0.2, focusY: 0.5 } }), /iw\*0\.2000/);
  assert.match(await graphOf({}), /crop=1080:1920,fps/);
});

const python = process.env.REFRAME_PYTHON ?? "python3";
const focusScript = new URL("../../../workers/reframe/focus.py", import.meta.url).pathname;
const haveCv = (() => { try { execFileSync(python, ["-c", "import cv2, skimage; assert not cv2.CascadeClassifier(cv2.data.haarcascades + \"haarcascade_frontalface_default.xml\").empty()"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("real video: face-aware 9:16 keeps a off-centre speaker in frame where a centre crop loses them", { skip: !haveCv }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-reframe-"));
  try {
    const frame = join(dir, "frame.png");
    const source = join(dir, "wide.mp4");
    execFileSync(python, ["-c", `
import cv2, numpy as np
from skimage import data
img = cv2.cvtColor(data.astronaut(), cv2.COLOR_RGB2BGR)
img = cv2.resize(img, (400, 400))
canvas = np.full((720, 1280, 3), 40, np.uint8)
canvas[160:560, 880:1280] = img
cv2.imwrite(${JSON.stringify(frame)}, canvas)`]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-framerate", "30", "-t", "4", "-i", frame, "-pix_fmt", "yuv420p", "-c:v", "libx264", source]);
    const focusOf = (path, s, e) => JSON.parse(execFileSync(python, [focusScript, path, String(s), String(e)]).toString());
    const found = focusOf(source, 0, 3);
    assert.ok(found.x > 0.75 && found.confidence >= 0.5, "speaker detected on the right: " + JSON.stringify(found));

    const render = async (withFocus) => {
      const out = join(dir, withFocus ? "focus.mp4" : "centre.mp4");
      const resolver = { resolve: async () => source, ...(withFocus ? { focus: async (_a, s, e) => focusOf(source, s / 1e6, e / 1e6) } : {}) };
      const plan = await new FfmpegCommandPlanner(resolver).plan(revision([clip("c", 0, 3_000_000, 0)]), { ...PLATFORM_PRESETS.tiktok.settings, captionStyle: undefined }, out);
      await new FfmpegProcess().run(plan);
      return out;
    };
    const centre = focusOf(await render(false), 0, 2);
    const aimed = focusOf(await render(true), 0, 2);
    assert.equal(centre.x, null, "a centre crop of the wide frame loses the speaker");
    assert.ok(aimed.x !== null && aimed.confidence >= 0.5, "the aimed crop keeps the speaker: " + JSON.stringify(aimed));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real ffmpeg: audio is loudness-normalised so a quiet source reaches the target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-loud-"));
  try {
    const source = join(dir, "quiet.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=12:r=25", "-f", "lavfi", "-i", "sine=f=220:d=12", "-af", "volume=-30dB", "-pix_fmt", "yuv420p", "-shortest", source]);
    const measure = (path) => {
      const out = (() => { try { return execFileSync("ffmpeg", ["-nostats", "-i", path, "-af", "ebur128", "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] }).toString(); } catch (e) { return String(e.stderr); } })();
      return execFileSync("sh", ["-c", "ffmpeg -nostats -i " + JSON.stringify(path) + " -af ebur128 -f null - 2>&1 | grep -A1 'Integrated loudness' | grep -o 'I: *-\\?[0-9.]*' | tail -1"]).toString().trim() || out.slice(-200);
    };
    const render = async (extra, name) => {
      const out = join(dir, name);
      const plan = await new FfmpegCommandPlanner({ resolve: async () => source, hasAudio: async () => true }).plan(revision([clip("c", 0, 12_000_000, 0)]), { ...settings, width: 320, height: 240, ...extra }, out);
      await new FfmpegProcess().run(plan);
      return Number(measure(out).replace(/[^0-9.-]/g, ""));
    };
    const raw = await render({ normalizeLoudness: false }, "raw.mp4");
    const normalised = await render({}, "norm.mp4");
    assert.ok(raw < -28, "source stays quiet without normalisation: " + raw);
    assert.ok(Math.abs(normalised - -16) < 2.5, "normalised near -16 LUFS: " + normalised);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real ffmpeg: background music loops under the cut and ducks while someone speaks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-music-"));
  try {
    // "Speech": a 1 kHz tone for 0-2s and 4-6s with silence between; music: a steady 300 Hz tone of only 2.5s (must loop).
    const talk = join(dir, "talk.mp4");
    const song = join(dir, "song.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=6:r=25", "-f", "lavfi", "-i", "sine=f=1000:d=6,volume=enable='between(t,2,4)':volume=0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", talk]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=300:d=2.5", song]);
    const resolver = { resolve: async (id) => (id === "song" ? song : talk), hasAudio: async () => true };
    const music = { id: "music", assetId: "song", sourceStartUs: 0, sourceEndUs: 6_000_000, timelineStartUs: 0, timelineEndUs: 6_000_000, transform: { role: "music", volumeDb: -6, duck: true } };
    const render = async (name, extra = {}) => {
      const out = join(dir, name);
      const plan = await new FfmpegCommandPlanner(resolver).plan(revision([clip("c", 0, 6_000_000, 0)], [{ id: "a", kind: "audio", clips: [{ ...music, transform: { ...music.transform, ...extra } }] }]), { ...settings, width: 320, height: 240, normalizeLoudness: false }, out);
      await new FfmpegProcess().run(plan);
      return out;
    };
    // RMS (dB) of the 300 Hz music band in a time window.
    const band = (path, from, to) => {
      const out = execFileSync("sh", ["-c", "ffmpeg -nostats -v info -ss " + from + " -t " + (to - from) + " -i " + JSON.stringify(path) + " -af bandpass=f=300:width_type=h:w=80,astats=metadata=0:reset=0 -f null - 2>&1 | grep 'RMS level dB' | tail -1"]).toString();
      return Number(out.split(":").pop());
    };
    const ducked = await render("ducked.mp4");
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-of", "json", ducked]).toString());
    assert.ok(Math.abs(Number(probe.format.duration) - 6) < 0.2, "music is trimmed to the cut: " + probe.format.duration);
    const underSpeech = band(ducked, 0.6, 1.6);
    const inPause = band(ducked, 2.7, 3.5);
    const afterLoop = band(ducked, 2.55, 2.9);
    assert.ok(inPause - underSpeech >= 6, "music ducks by ≥6 dB under speech: speech " + underSpeech + " dB vs pause " + inPause + " dB");
    assert.ok(afterLoop > -40, "a 2.5s track keeps playing past its end because it loops: " + afterLoop);

    const flat = await render("flat.mp4", { duck: false });
    assert.ok(Math.abs(band(flat, 2.7, 3.5) - band(flat, 0.6, 1.6)) < 3, "without ducking the music level is steady");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real ffmpeg: b-roll stills and clips appear full-frame or as a top-right inset only during their window, under captions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-broll-"));
  try {
    const talk = join(dir, "talk.mp4");
    const red = join(dir, "red.png");
    const blue = join(dir, "blue.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x404040:s=640x360:d=6:r=25", "-pix_fmt", "yuv420p", talk]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=400x400:d=1", "-frames:v", "1", red]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=3:r=25", "-pix_fmt", "yuv420p", blue]);
    const paths = { talk, red, blue };
    const resolver = { resolve: async (id) => paths[id], isStill: async (id) => id === "red" };
    const overlay = { id: "o", kind: "overlay", clips: [
      { id: "b1", assetId: "red", sourceStartUs: 0, sourceEndUs: 1_000_000, timelineStartUs: 1_000_000, timelineEndUs: 2_000_000, transform: { role: "broll", mode: "full" } },
      { id: "b2", assetId: "blue", sourceStartUs: 0, sourceEndUs: 1_500_000, timelineStartUs: 3_000_000, timelineEndUs: 4_500_000, transform: { role: "broll", mode: "pip" } },
    ] };
    const out = join(dir, "out.mp4");
    const plan = await new FfmpegCommandPlanner(resolver).plan(revision([clip("c", 0, 6_000_000, 0)].map((c) => ({ ...c, assetId: "talk" })), [overlay]), { ...settings, width: 640, height: 360, captionStyle: undefined }, out);
    await new FfmpegProcess().run(plan);
    // Average colour of a region at a time, as [r, g, b].
    const colour = (t, crop) => {
      const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "crop=" + crop + ",scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      return [...raw.subarray(0, 3)];
    };
    const isRed = ([r, g, b]) => r > 180 && g < 70 && b < 70;
    const isBlue = ([r, g, b]) => b > 180 && r < 70 && g < 70;
    const isGrey = ([r, g, b]) => Math.abs(r - 64) < 20 && Math.abs(g - 64) < 20 && Math.abs(b - 64) < 20;
    assert.ok(isGrey(colour(0.5, "640:360:0:0")), "main video before the b-roll");
    assert.ok(isRed(colour(1.5, "640:360:0:0")), "still covers the full frame during its window: " + colour(1.5, "640:360:0:0"));
    assert.ok(isGrey(colour(2.5, "640:360:0:0")), "gone after its window");
    assert.ok(isBlue(colour(3.7, "120:60:500:30")), "clip inset sits top-right: " + colour(3.7, "120:60:500:30"));
    assert.ok(isGrey(colour(3.7, "200:100:40:220")), "rest of the frame is still the main video");
    assert.ok(isGrey(colour(5.0, "120:60:500:30")), "inset gone after its window");
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-of", "json", out]).toString());
    assert.ok(Math.abs(Number(probe.format.duration) - 6) < 0.2, "overlays do not change the length: " + probe.format.duration);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real ffmpeg: a title card pops in only during its window, a lower third slides in, and the progress bar tracks time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-gfx-"));
  try {
    const talk = join(dir, "talk.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x303030:s=640x360:d=8:r=25", "-pix_fmt", "yuv420p", talk]);
    const overlay = { id: "o", kind: "overlay", clips: [
      { id: "g1", assetId: "generated:graphic", sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 1_000_000, timelineEndUs: 3_000_000, transform: { role: "graphic", kind: "title", text: "ONBOARDING", position: "center", color: "#FFA000" } },
      { id: "g2", assetId: "generated:graphic", sourceStartUs: 0, sourceEndUs: 2_500_000, timelineStartUs: 4_500_000, timelineEndUs: 7_000_000, transform: { role: "graphic", kind: "lower-third", text: "Ada Obi", subtitle: "Founder", position: "bottom", color: "#FF00FF" } },
      { id: "progress", assetId: "generated:progress", sourceStartUs: 0, sourceEndUs: 8_000_000, timelineStartUs: 0, timelineEndUs: 8_000_000, transform: { role: "progress", color: "#00FF00" } },
    ] };
    const out = join(dir, "out.mp4");
    const plan = await new FfmpegCommandPlanner({ resolve: async () => talk }).plan(revision([clip("c", 0, 8_000_000, 0)], [overlay]), { ...settings, width: 640, height: 360, captionStyle: undefined }, out);
    await new FfmpegProcess().run(plan);
    // Fraction of pixels in a region matching a colour test.
    const share = (t, crop, match) => {
      const [w, h] = crop.split(":").map(Number);
      const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "crop=" + crop, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      let hits = 0;
      for (let i = 0; i < w * h * 3; i += 3) if (match(raw[i], raw[i + 1], raw[i + 2])) hits += 1;
      return hits / (w * h);
    };
    const amber = (r, g, b) => r > 200 && g > 120 && g < 200 && b < 80;
    const magenta = (r, g, b) => r > 190 && g < 80 && b > 190;
    const green = (r, g, b) => g > 180 && r < 90 && b < 90;
    assert.ok(share(2.0, "640:120:0:100", amber) > 0.03, "title box visible mid-window: " + share(2.0, "640:120:0:100", amber));
    assert.equal(share(0.5, "640:120:0:100", amber), 0, "no title before its window");
    assert.equal(share(3.6, "640:120:0:100", amber), 0, "gone after its window");
    assert.ok(share(6.0, "80:200:0:100", magenta) > 0.01, "lower-third bar visible mid-window: " + share(6.0, "80:200:0:100", magenta));
    assert.equal(share(4.0, "80:200:0:100", magenta), 0, "no lower third before its window");
    const filled = (t) => share(t, "640:2:0:0", green);
    assert.ok(Math.abs(filled(2.0) - 0.25) < 0.06, "progress ~25% at 2s of 8s: " + filled(2.0));
    assert.ok(Math.abs(filled(6.0) - 0.75) < 0.06, "progress ~75% at 6s of 8s: " + filled(6.0));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("captions and titles move off the speaker's face, following the clip's crop", async () => {
  // A low face in a 9:16 source (face spans 55%..72% of the height): the bold-pop band sits over it.
  const track = { step: 0.5, boxes: Array.from({ length: 20 }, (_, i) => (i < 10 ? [0.3, 0.55, 0.7, 0.72] : null)) };
  const planner = new FfmpegCommandPlanner({ resolve: async () => "/media/source.mp4", faces: async () => track, dimensions: async () => ({ width: 1080, height: 1920 }) });
  const cue = (id, s, e, text) => ({ id, assetId: "asset", sourceStartUs: s, sourceEndUs: e, timelineStartUs: s, timelineEndUs: e, transform: { text } });
  const captions = { id: "c", kind: "caption", clips: [cue("q1", 0, 2_000_000, "face is here"), cue("q2", 6_000_000, 8_000_000, "no face now")] };
  const overlay = { id: "o", kind: "overlay", clips: [{ id: "g", assetId: "asset", sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000, transform: { role: "graphic", kind: "title", text: "Hello", position: "center" } }] };
  const plan = await planner.plan(revision([clip("c", 0, 9_000_000, 0)], [captions, overlay]), { ...PLATFORM_PRESETS.tiktok.settings }, "/renders/o.mp4");
  const ass = plan.files.find((f) => f.path.endsWith(".captions.ass")).content;
  const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  const margin = (line) => Number(line.split(",")[7]);
  const moved = margin(events[0]);
  assert.ok(moved > 0, "first caption has its own margin");
  const bottom = 1920 - moved;
  assert.ok(bottom <= 0.55 * 1920 || bottom - 260 >= 0.72 * 1920, "caption clear of the face: bottom at " + bottom);
  assert.equal(margin(events[events.length - 1]), 0, "without a face the caption keeps the style's place");
  const graphics = plan.files.find((f) => f.path.endsWith(".graphics.ass")).content;
  const y = Number(/\\pos\(\d+,(\d+)\)/.exec(graphics)[1]);
  assert.ok(y < 0.55 * 1920 - 60 || y > 0.72 * 1920 + 60, "title clear of the face at " + y);
});

test("real video: the face track finds the speaker and stays empty without a face", { skip: !haveCv }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-faces-"));
  try {
    const frame = join(dir, "frame.png"); const withFace = join(dir, "face.mp4"); const noFace = join(dir, "none.mp4");
    execFileSync(python, ["-c", `
import cv2, numpy as np
from skimage import data
img = cv2.cvtColor(data.astronaut(), cv2.COLOR_RGB2BGR)
canvas = np.full((1280, 720, 3), 40, np.uint8)
canvas[700:1212, 104:616] = img
cv2.imwrite(${JSON.stringify(frame)}, canvas)`]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-framerate", "25", "-t", "3", "-i", frame, "-pix_fmt", "yuv420p", "-c:v", "libx264", withFace]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=25:duration=3", "-pix_fmt", "yuv420p", "-c:v", "libx264", noFace]);
    const facesScript = new URL("../../../workers/reframe/faces.py", import.meta.url).pathname;
    const track = (path) => JSON.parse(execFileSync(python, [facesScript, path]).toString());
    const found = track(withFace);
    const boxes = found.boxes.filter(Boolean);
    assert.ok(boxes.length >= found.boxes.length - 1, "face seen throughout: " + JSON.stringify(found));
    // The astronaut's face sits in the lower half of the tall frame.
    assert.ok(boxes[0][1] > 0.5 && boxes[0][3] < 1, JSON.stringify(boxes[0]));
    assert.deepEqual(track(noFace).boxes.filter(Boolean), [], "no false faces on a test pattern");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real video: the background behind the person is replaced, and a cutaway can sit behind them", { skip: !haveCv }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-bg-"));
  try {
    const frame = join(dir, "frame.png"); const source = join(dir, "person.mp4"); const backdrop = join(dir, "backdrop.png");
    // The astronaut photo on a mid-grey studio wall, in a 9:16 frame.
    execFileSync(python, ["-c", `
import cv2, numpy as np
from skimage import data
img = cv2.cvtColor(data.astronaut(), cv2.COLOR_RGB2BGR)
canvas = np.full((1280, 720, 3), 128, np.uint8)
canvas[600:1112, 104:616] = img
cv2.imwrite(${JSON.stringify(frame)}, canvas)
cv2.imwrite(${JSON.stringify(backdrop)}, np.tile(np.array([200, 40, 40], np.uint8), (720, 1280, 1)))`]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-framerate", "25", "-t", "3", "-i", frame, "-pix_fmt", "yuv420p", "-c:v", "libx264", source]);
    const matteScript = new URL("../../../workers/reframe/matte.py", import.meta.url).pathname;
    let n = 0;
    const resolver = {
      resolve: async (id) => (id === "photo" ? backdrop : source), isStill: async (id) => id === "photo",
      matte: async (_id, s, e, o) => { const out = join(dir, "matte" + n++ + ".mp4"); execFileSync(python, [matteScript, source, String(s / 1e6), String(e / 1e6), out, String(o.edge), String(o.feather)]); return out; },
    };
    const settings = { ...PLATFORM_PRESETS.tiktok.settings, width: 360, height: 640, captionStyle: undefined };
    const pixel = (path, x, y) => [...execFileSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", path, "-frames:v", "1", "-vf", "crop=4:4:" + x + ":" + y + ",scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];
    // 1. A solid colour background: the wall turns blue-green, the face stays.
    const coloured = join(dir, "coloured.mp4");
    await new FfmpegProcess().run(await new FfmpegCommandPlanner(resolver).plan(revision([{ ...clip("c", 0, 2_000_000, 0), transform: { background: "color", backgroundColor: "#1060C0" } }]), settings, coloured));
    const wall = pixel(coloured, 20, 40); const face = pixel(coloured, 165, 370);
    assert.ok(wall[2] > 150 && wall[0] < 60, "wall replaced: " + wall);
    assert.ok(face[0] > 120 && face[0] > face[2], "face kept: " + face);
    // 2. A photo placed behind the person for the middle second only.
    const behindOut = join(dir, "behind.mp4");
    const overlay = { id: "o", kind: "overlay", clips: [{ id: "b", assetId: "photo", sourceStartUs: 0, sourceEndUs: 1_000_000, timelineStartUs: 500_000, timelineEndUs: 1_500_000, transform: { role: "broll", mode: "behind", motion: "none" } }] };
    await new FfmpegProcess().run(await new FfmpegCommandPlanner(resolver).plan(revision([clip("c", 0, 2_000_000, 0)], [overlay]), settings, behindOut));
    const wall2 = pixel(behindOut, 20, 40); const face2 = pixel(behindOut, 165, 370);
    assert.ok(wall2[0] < 100 && wall2[2] > 150, "cutaway behind: " + wall2);
    assert.ok(face2[0] > 120 && face2[0] > face2[2], "person in front: " + face2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
