import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStillImage, detectSceneCuts, parseSceneCuts, scenesFromCuts, detectFocus, parseFocus, parseSilenceDetect, parseProbe, speechSpans, pausesFromWords, validateMedia, probeMedia, detectSilence } from "../dist/index.js";

test("parses silencedetect output including a trailing open silence", () => {
  const out = "[silencedetect @ 0x1] silence_start: 1.5\n[silencedetect @ 0x1] silence_end: 2.25 | silence_duration: 0.75\n[silencedetect @ 0x1] silence_start: 9.0\n";
  assert.deepEqual(parseSilenceDetect(out, 10_000_000), [{ startUs: 1_500_000, endUs: 2_250_000 }, { startUs: 9_000_000, endUs: 10_000_000 }]);
});

test("speech spans are the padded complement of silences", () => {
  const speech = speechSpans(10_000_000, [{ startUs: 2_000_000, endUs: 4_000_000 }], { paddingUs: 100_000 });
  assert.deepEqual(speech, [{ startUs: 0, endUs: 2_100_000 }, { startUs: 3_900_000, endUs: 10_000_000 }]);
});

test("pauses are inferred from word gaps", () => {
  const words = [{ text: "a", startUs: 0, endUs: 300_000 }, { text: "b", startUs: 400_000, endUs: 600_000 }, { text: "c", startUs: 1_600_000, endUs: 1_800_000 }];
  assert.deepEqual(pausesFromWords(words, 500_000), [{ startUs: 600_000, endUs: 1_600_000 }]);
});

test("probe parsing handles rotation and rejects missing duration", () => {
  const info = parseProbe(JSON.stringify({ format: { duration: "12.5", format_name: "mov,mp4", size: "1000" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", side_data_list: [{ rotation: -90 }] }, { codec_type: "audio", codec_name: "aac" }] }));
  assert.equal(info.durationUs, 12_500_000);
  assert.deepEqual([info.width, info.height], [1080, 1920]);
  assert.equal(info.hasAudio, true);
  assert.throws(() => parseProbe(JSON.stringify({ format: {}, streams: [] })), /duration/);
  assert.throws(() => validateMedia({ durationUs: 1, formatName: "x", sizeBytes: 1, hasVideo: false, hasAudio: false }), /no audio or video/);
});

test("real ffmpeg: probes a generated file and finds its silence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-analysis-"));
  try {
    const file = join(dir, "tone.mp4");
    // 2s tone, 1.5s silence, 2s tone with a video track.
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25:d=5.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5.5", "-af", "volume='if(between(t,2,3.5),0,1)':eval=frame", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file]);
    const info = await probeMedia(file);
    assert.ok(Math.abs(info.durationUs - 5_500_000) < 150_000);
    assert.equal(info.hasVideo && info.hasAudio, true);
    assert.deepEqual([info.width, info.height], [320, 180]);
    const silences = await detectSilence(file, { noiseDb: -40, minDurationUs: 500_000 });
    assert.equal(silences.length, 1);
    assert.ok(Math.abs(silences[0].startUs - 2_000_000) < 200_000, JSON.stringify(silences));
    assert.ok(Math.abs(silences[0].endUs - 3_500_000) < 200_000, JSON.stringify(silences));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parses scene cut timestamps and builds contiguous scenes", () => {
  const out = "[Parsed_showinfo_1 @ 0x1] n:   0 pts:  60 pts_time:2.5 pos: 1\n[Parsed_showinfo_1 @ 0x1] n:   1 pts: 120 pts_time:5 pos: 2\n";
  assert.deepEqual(parseSceneCuts(out), [2_500_000, 5_000_000]);
  assert.deepEqual(scenesFromCuts([2_500_000, 5_000_000], 8_000_000), [{ startUs: 0, endUs: 2_500_000 }, { startUs: 2_500_000, endUs: 5_000_000 }, { startUs: 5_000_000, endUs: 8_000_000 }]);
  assert.deepEqual(scenesFromCuts([], 3_000_000), [{ startUs: 0, endUs: 3_000_000 }]);
});

test("parseFocus returns null when no subject was found and clamps coordinates", () => {
  assert.equal(parseFocus('{"x":null,"y":null,"confidence":0,"samples":4}'), null);
  assert.deepEqual(parseFocus('{"x":1.4,"y":0.3,"confidence":0.8,"samples":4}'), { x: 1, y: 0.3, confidence: 0.8 });
});

test("real ffmpeg: finds the shot changes in a video made of three colour shots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-scenes-"));
  try {
    const path = join(dir, "shots.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=25", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2:r=25", "-f", "lavfi", "-i", "color=c=lime:s=320x240:d=2:r=25", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-pix_fmt", "yuv420p", path]);
    const cuts = await detectSceneCuts(path);
    assert.equal(cuts.length, 2);
    assert.ok(Math.abs(cuts[0] - 2_000_000) < 80_000 && Math.abs(cuts[1] - 4_000_000) < 80_000, JSON.stringify(cuts));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real ffprobe: stills are recognised, videos are not, and junk is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-still-"));
  try {
    for (const name of ["a.png", "a.jpg", "a.webp"]) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", join(dir, name)]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1:r=10", "-pix_fmt", "yuv420p", join(dir, "a.mp4")]);
    for (const name of ["a.png", "a.jpg", "a.webp"]) assert.equal(await isStillImage(join(dir, name)), true, name);
    assert.equal(await isStillImage(join(dir, "a.mp4")), false);
    const junk = join(dir, "junk.png");
    execFileSync("sh", ["-c", "echo not an image > " + JSON.stringify(junk)]);
    await assert.rejects(isStillImage(junk));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parseFaceTrack validates and clamps boxes", async () => {
  const { parseFaceTrack } = await import("../dist/index.js");
  const track = parseFaceTrack(JSON.stringify({ step: 0.5, engine: "yunet", boxes: [[0.1, 0.2, 0.3, 0.4], null, [0.5, 0.5, 0.4, 0.6], [-1, 0, 2, 1], "x"] }));
  assert.equal(track.step, 0.5);
  assert.deepEqual(track.boxes, [[0.1, 0.2, 0.3, 0.4], null, null, [0, 0, 1, 1], null]);
  assert.throws(() => parseFaceTrack(JSON.stringify({ step: 0, boxes: [] })));
});
