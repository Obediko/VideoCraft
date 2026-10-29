import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegCommandPlanner, FfmpegProcess } from "../dist/index.js";

const settings = { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 640, height: 360, frameRate: 25, captionStyle: undefined };
const at = (clips) => { let t = 0; return clips.map((c) => { const out = { ...c, timelineStartUs: t, timelineEndUs: t + c.sourceEndUs - c.sourceStartUs }; t = out.timelineEndUs; return out; }); };
const revision = (clips, extra = []) => ({ projectId: "p", revision: 1, timeline: { durationUs: clips.at(-1).timelineEndUs, tracks: [{ id: "v", kind: "video", clips }, ...extra] }, acceptedProposalIds: [], createdAt: "", createdBy: "u" });

test("real ffmpeg: punch-in, push-in, looks, dip and flash transitions and a sound effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-fx-"));
  try {
    // A colourful source: left half orange, right half teal, with a white square in the middle; silent audio.
    const src = join(dir, "src.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xE07020:s=640x360:d=12:r=25", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-filter_complex", "[0:v]drawbox=x=320:y=0:w=320:h=360:c=0x20A0A0:t=fill,drawbox=x=300:y=160:w=40:h=40:c=white:t=fill[v]", "-map", "[v]", "-map", "1:a", "-t", "12", "-pix_fmt", "yuv420p", "-shortest", src]);
    const s = (a, b, transform) => ({ id: "c" + a, assetId: "src", sourceStartUs: a * 1e6, sourceEndUs: b * 1e6, ...(transform ? { transform } : {}) });
    const clips = at([s(0, 2), s(2, 4, { zoom: "punch" }), s(4, 6, { look: "mono", transitionIn: "dip-black" }), s(6, 8, { transitionIn: "flash", zoom: "push" }), s(8, 10, { transitionOut: "dip-black" })]);
    const audio = { id: "a", kind: "audio", clips: [{ id: "fx", assetId: "generated:sfx", sourceStartUs: 0, sourceEndUs: 700_000, timelineStartUs: 1_000_000, timelineEndUs: 1_700_000, transform: { role: "sfx", kind: "whoosh", volumeDb: -6 } }] };
    const out = join(dir, "out.mp4");
    const plan = await new FfmpegCommandPlanner({ resolve: async () => src, hasAudio: async () => true }).plan(revision(clips, [audio]), settings, out);
    await new FfmpegProcess().run(plan);
    const px = (t, crop = "640:360:0:0") => [...execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "crop=" + crop + ",scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).subarray(0, 3)];
    const width = (t) => { // width of the white square on the middle row
      const row = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "crop=640:2:0:180,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
      return [...row.subarray(0, 640)].filter((v) => v > 230).length;
    };
    const plain = width(1.0); const punched = width(3.0);
    assert.ok(plain >= 36 && plain <= 44, "square at normal size: " + plain);
    assert.ok(punched >= plain * 1.08 && punched <= plain * 1.18, "punch-in enlarges the frame ~12%: " + plain + " → " + punched);
    const pushStart = width(6.3); const pushEnd = width(7.8);
    assert.ok(pushEnd > pushStart, "push-in grows over the clip: " + pushStart + " → " + pushEnd);
    const [r, g, b] = px(5.0, "200:200:20:80");
    assert.ok(Math.abs(r - g) < 12 && Math.abs(g - b) < 12, "mono look is grey: " + [r, g, b]);
    assert.ok(px(4.02).every((v) => v < 40), "dip to black at the cut into clip 3: " + px(4.02));
    assert.ok(px(3.98).every((v) => v < 60), "the outgoing clip fades down too: " + px(3.98));
    assert.ok(px(6.02).every((v) => v > 200), "flash to white at the cut into clip 4: " + px(6.02));
    assert.ok(px(9.97).every((v) => v < 40), "fades to black at the end: " + px(9.97));
    const orange = px(0.5, "100:100:50:50");
    assert.ok(orange[0] > 180 && orange[2] < 80, "untouched clips keep their colour: " + orange);
    // The whoosh is in the mix at 1.0-1.7 s and nowhere else (the source is silent).
    const level = (start, dur) => { const pcm = execFileSync("ffmpeg", ["-v", "error", "-ss", String(start), "-t", String(dur), "-i", out, "-ac", "1", "-f", "s16le", "-"]); let e = 0; for (let i = 0; i < pcm.length; i += 2) e += pcm.readInt16LE(i) ** 2; return Math.sqrt(e / (pcm.length / 2)); };
    assert.ok(level(1.1, 0.5) > 300, "whoosh is audible: " + level(1.1, 0.5));
    assert.ok(level(3, 1) < 30, "silence elsewhere: " + level(3, 1));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-of", "json", out]).toString());
    assert.ok(Math.abs(Number(probe.format.duration) - 10) < 0.15, "effects do not change the length: " + probe.format.duration);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real ffmpeg: a still used as B-roll drifts instead of sitting frozen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-kb-"));
  try {
    const src = join(dir, "src.mp4"); const still = join(dir, "still.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x404040:s=640x360:d=5:r=25", "-pix_fmt", "yuv420p", src]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=800x450", "-frames:v", "1", still]);
    const clips = at([{ id: "c", assetId: "src", sourceStartUs: 0, sourceEndUs: 5_000_000 }]);
    const overlay = { id: "o", kind: "overlay", clips: [{ id: "b", assetId: "still", sourceStartUs: 0, sourceEndUs: 3_000_000, timelineStartUs: 1_000_000, timelineEndUs: 4_000_000, transform: { role: "broll", mode: "full" } }] };
    const out = join(dir, "out.mp4");
    const plan = await new FfmpegCommandPlanner({ resolve: async (id) => (id === "still" ? still : src), isStill: async (id) => id === "still" }).plan(revision(clips, [overlay]), settings, out);
    await new FfmpegProcess().run(plan);
    const frame = (t) => execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "scale=64:36", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    const a = frame(1.3), b = frame(3.7);
    let diff = 0; for (let i = 0; i < a.length; i += 1) diff += Math.abs(a[i] - b[i]);
    assert.ok(diff / a.length > 6, "the still moves over its window: " + diff / a.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every look renders and changes the picture in its own direction", async () => {
  const { LOOK_FILTERS } = await import("../dist/index.js");
  const dir = mkdtempSync(join(tmpdir(), "vc-look-"));
  try {
    const src = join(dir, "src.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x8080A0:s=64x64", "-frames:v", "1", src]);
    const rgb = (vf) => [...execFileSync("ffmpeg", ["-v", "error", "-i", src, "-vf", "format=yuv420p," + vf + ",scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).subarray(0, 3)];
    const base = rgb("null");
    const out = Object.fromEntries(Object.entries(LOOK_FILTERS).map(([k, f]) => [k, rgb(f)]));
    assert.ok(out.warm[0] - out.warm[2] > base[0] - base[2] + 8, "warm: redder vs bluer " + base + " → " + out.warm);
    assert.ok(Math.abs(out.mono[0] - out.mono[2]) < 4, "mono is grey: " + out.mono);
    const spread = (c) => Math.max(...c) - Math.min(...c);
    assert.ok(spread(out.vivid) > spread(base), "vivid is more saturated: " + out.vivid);
    assert.ok(spread(out.soft) < spread(base) + 1, "soft is not more saturated: " + out.soft);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
