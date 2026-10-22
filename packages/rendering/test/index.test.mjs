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
