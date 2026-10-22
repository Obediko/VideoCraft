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
