import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { InMemoryAssetRepository, InMemoryProjectRepository, InMemoryRevisionRepository, ProjectService } from "@videocraft/application";
import { probeMedia, isStillImage } from "@videocraft/analysis";
import { LocalObjectStorage } from "@videocraft/storage";
import { applyTimelineOperations, parseTimelineOperations } from "@videocraft/domain";
import { FfmpegCommandPlanner, FfmpegProcess } from "@videocraft/rendering";
import { registerCreationRoutes, storyTimeline, storyScenes, sampleStoryFrames, storyboardPlanner } from "../dist/creation.js";

const photo = { id: "photo", projectId: "p", kind: "image", storageKey: "projects/p/assets/photo.media", checksumSha256: "a".repeat(64), metadata: { filename: "Photo.png" }, createdAt: "" };
const video = { ...photo, id: "video", kind: "video", durationUs: 1_200_000, metadata: { filename: "Video.mp4" } };
const voice = { ...photo, id: "voice", kind: "audio", durationUs: 3_600_000, metadata: { filename: "Human narration.wav" } };
const scenes = [{ assetId: "video", startS: 0, durationS: 1, text: "First", visual: "Blue clip" }, { assetId: "photo", startS: 0, durationS: 1, text: "Second", visual: "Red photo" }];

async function setup(plan, segments = []) {
  const directory = mkdtempSync(join(tmpdir(), "vc-creation-"));
  const projects = new InMemoryProjectRepository(), assets = new InMemoryAssetRepository(), revisions = new InMemoryRevisionRepository();
  await projects.save({ id: "p", ownerId: "u", name: "Story", revision: 0, createdAt: "", updatedAt: "" });
  for (const a of [photo, video, voice]) await assets.save(a);
  const service = new ProjectService(projects, assets, revisions, { next: () => "id" }, { now: () => "2026-10-31T10:00:00Z" });
  let access = true, signedIn = true;
  const server = Fastify(); const storage = new LocalObjectStorage(directory);
  registerCreationRoutes(server, { projects, assets, revisions, storage, transcripts: { listForAsset: async id => id === "voice" ? segments : [] }, authenticate: async () => signedIn ? { userId: "u" } : null, authorize: { canAccess: async () => access }, saveRevision: input => service.saveRevision(input), clock: () => "2026-10-31T10:00:00Z", ...(plan ? { plan } : {}) });
  return { server, assets, storage, directory, access: value => { access = value; }, signIn: value => { signedIn = value; }, close: async () => { await server.close(); rmSync(directory, { force: true, recursive: true }); } };
}

test("storyboard plans without speech or uploads, marks unresolved visuals, and explicitly falls back on provider failure", async () => {
  const s = await setup(async () => { throw new Error("provider offline"); });
  try {
    const response = await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/plan", payload: { brief: "Tell a story about a mentoring programme", seconds: 30, assetIds: [] } });
    assert.equal(response.statusCode, 200, response.body);
    const { plan } = response.json(); assert.equal(plan.source, "rules"); assert.match(plan.note, /unavailable/); assert.equal(plan.scenes[0].assetId, ""); assert.equal(plan.script, "");
    const unresolved = await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/apply", payload: { revision: 0, scenes: plan.scenes } });
    assert.equal(unresolved.statusCode, 400);
  } finally { await s.close(); }
});

test("AI can reorder selected assets; invalid provider asset IDs fall back without importing foreign media", async () => {
  let invalid = false;
  const s = await setup(async input => {
    assert.deepEqual(input.assets.map(a => a.id), ["video", "photo"]);
    return { summary: "Open on the photo", script: "Our story begins here.", scenes: invalid ? [{ ...scenes[0], assetId: "foreign" }] : [...scenes].reverse() };
  });
  try {
    const payload = { brief: "Make a narrated story", seconds: 10, assetIds: ["video", "photo"] };
    const result = await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/plan", payload });
    assert.equal(result.statusCode, 200); assert.equal(result.json().plan.source, "ai");
    assert.deepEqual(result.json().plan.scenes.map(s => s.assetId), ["photo", "video"]);
    invalid = true;
    const fallback = await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/plan", payload });
    assert.equal(fallback.json().plan.source, "rules"); assert.deepEqual(fallback.json().plan.scenes.map(s => s.assetId), ["video", "photo"]);
  } finally { await s.close(); }
});

test("speech captions use actual narration timing, and assembly refuses captions when transcription is missing", async () => {
  const segment = { words: [{ text: "Jesus", startUs: 200_000, endUs: 600_000 }, { text: "truly", startUs: 800_000, endUs: 1_200_000 }, { text: "saves", startUs: 2_500_000, endUs: 3_300_000 }] };
  const s = await setup(undefined, [segment]);
  try {
    const response = await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/apply", payload: { revision: 0, scenes, narrationAssetId: "voice", captions: true } });
    assert.equal(response.statusCode, 201, response.body);
    const cue = response.json().revision.timeline.tracks.find(t => t.kind === "caption").clips[0];
    assert.equal(cue.timelineStartUs, 200_000); assert.equal(cue.timelineEndUs, 3_300_000); assert.equal(cue.transform.text, "Jesus truly saves");
  } finally { await s.close(); }
  const missing = await setup();
  try {
    const result = await missing.server.inject({ method: "POST", url: "/v1/projects/p/creation/apply", payload: { revision: 0, scenes, narrationAssetId: "voice", captions: true } });
    assert.equal(result.statusCode, 400); assert.match(result.json().error.message, /Transcribe/);
  } finally { await missing.close(); }
});

test("foreign assets, audio used as pictures, stale revisions and invalid source ranges cannot enter an assembled story", async () => {
  const s = await setup();
  try {
    for (const changes of [{ assetId: "foreign" }, { assetId: "voice" }, { startS: -1 }, { durationS: 80 }, { startS: 0.5, durationS: 1 }]) {
      const response = await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/apply", payload: { revision: 0, scenes: [{ ...scenes[0], ...changes }] } });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.throws(() => storyScenes([{ ...scenes[1], startS: 1 }], [photo]), /zero/);
    const payload = { revision: 0, scenes, narrationAssetId: "voice", sceneText: true, music: true, brief: "Our story", platform: "square" };
    const applied = await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/apply", payload });
    assert.equal(applied.statusCode, 201, applied.body);
    const { revision } = applied.json(); assert.equal(revision.timeline.durationUs, voice.durationUs); assert.equal(revision.tailoring.channel, "square");
    const sound = revision.timeline.tracks.filter(t => t.kind === "audio").flatMap(t => t.clips);
    assert.equal(sound.find(c => c.transform.role === "voiceover").timelineEndUs, voice.durationUs, "music preparation must not discard narration");
    assert.ok(sound.some(c => c.transform.role === "music"));
    assert.equal((await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/apply", payload })).statusCode, 409);
    s.access(false); assert.equal((await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/plan", payload: {} })).statusCode, 403);
    s.signIn(false); assert.equal((await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/apply", payload: {} })).statusCode, 401);
  } finally { await s.close(); }
});

test("repeated photos keep separate scene text and narration survives a later timeline operation", () => {
  const story = storyTimeline([{ ...scenes[1], text: "First photo" }, { ...scenes[1], text: "Same photo, later" }], voice, true);
  const changed = applyTimelineOperations(story, [{ type: "set-look", look: "warm" }]);
  const graphics = changed.tracks.find(t => t.kind === "overlay").clips;
  assert.deepEqual(graphics.map(c => c.timelineStartUs), [0, 1e6]);
  assert.equal(changed.tracks.find(t => t.kind === "audio").clips[0].timelineEndUs, voice.durationUs);
  const added = applyTimelineOperations(changed, parseTimelineOperations([{ type: "add-graphic", kind: "title", text: "Only the second photo", anchorAssetId: "photo", anchorClipId: changed.tracks[0].clips[1].id, anchorSourceUs: 0, durationUs: 500_000 }]));
  assert.equal(added.tracks.find(t => t.kind === "overlay").clips.find(c => c.transform.text === "Only the second photo").timelineStartUs, 1e6);
  const split = applyTimelineOperations(changed, [{ type: "split-clip", clipId: changed.tracks[0].clips[0].id, atUs: 500_000 }]);
  assert.equal(split.tracks.find(t => t.kind === "overlay").clips.length, 2, "clip-bound titles survive a split");
  const order = [...changed.tracks[0].clips].reverse().map(c => c.id);
  const reordered = applyTimelineOperations(changed, [{ type: "reorder-clips", clipIds: order }]);
  assert.equal(reordered.tracks.find(t => t.kind === "audio").clips[0].timelineStartUs, 0, "whole-story narration stays at zero after a reorder");
});

test("mixed video and photo storyboard renders the approved visual, music and complete human narration to a decodable MP4", async () => {
  const s = await setup();
  try {
    const image = join(s.directory, "red.png"), movie = join(s.directory, "blue.mp4"), narration = join(s.directory, "voice.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=160x120", "-frames:v", "1", "-threads", "1", image]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=160x120:r=30:d=1.2", "-f", "lavfi", "-i", "sine=frequency=220:duration=1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", movie]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=3.6", narration]);
    const paths = { photo: image, video: movie, voice: narration };
    const response = await s.server.inject({ method: "POST", url: "/v1/projects/p/creation/apply", payload: { revision: 0, scenes, narrationAssetId: "voice", music: true, sceneText: true } });
    assert.equal(response.statusCode, 201, response.body);
    const revision = response.json().revision;
    const resolve = async id => paths[id] ?? s.storage.resolve((await s.assets.listForProject("p")).find(a => a.id === id).storageKey);
    const resolver = { resolve, isStill: async id => isStillImage(await resolve(id)), hasAudio: async id => (await probeMedia(await resolve(id))).hasAudio };
    const output = join(s.directory, "story.mp4");
    const plan = await new FfmpegCommandPlanner(resolver).plan(revision, { format: "mp4", videoCodec: "libx264", audioCodec: "aac", frameRate: 30, width: 180, height: 320, fit: "contain", normalizeLoudness: false }, output);
    await new FfmpegProcess().run(plan);
    execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", output], { encoding: "utf8" }));
    assert.ok(Number(probe.format.duration) >= 3.59); assert.ok(probe.streams.some(s => s.codec_type === "audio"));
    const frame = execFileSync("ffmpeg", ["-v", "error", "-ss", "2.5", "-i", output, "-frames:v", "1", "-vf", "crop=80:80:50:120,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    assert.ok(frame[0] > 150 && frame[0] > frame[2] * 2, "approved red photo remains visible after the original story length");
    const audio = execFileSync("ffmpeg", ["-v", "error", "-ss", "3.1", "-i", output, "-t", "0.25", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"]);
    let power = 0; for (let i = 0; i < audio.length; i += 4) power += audio.readFloatLE(i) ** 2;
    assert.ok(Math.sqrt(power / (audio.length / 4)) > 0.02, "narration remains audible at the end");
    let re = 0, im = 0;
    for (let i = 0; i < audio.length / 4; i++) { const a = audio.readFloatLE(i * 4), phase = 2 * Math.PI * 880 * i / 8000; re += a * Math.cos(phase); im += a * Math.sin(phase); }
    assert.ok(2 * Math.hypot(re, im) / (audio.length / 4) > 0.05, "the 880 Hz narration, rather than music alone, is present at the end");
  } finally { await s.close(); }
});


test("long narration extends a final photo in one input and refuses an unbounded number of short video repeats", () => {
  const longVoice = { ...voice, durationUs: 600_000_000 };
  const photoStory = storyTimeline([scenes[1]], longVoice, false, [photo]);
  assert.equal(photoStory.tracks[0].clips.length, 1);
  assert.equal(photoStory.durationUs, longVoice.durationUs);
  assert.throws(() => storyTimeline([{ ...scenes[0], durationS: 0.5 }], longVoice, false, [video]), /too many repeated clips/);
});


test("story planning sends real labelled photo/video samples to the model and skips oversized or unknown media", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vc-story-vision-"));
  const image = join(directory, "photo.png"), movie = join(directory, "video.mp4");
  const http = createServer((req, res) => {
    let raw = ""; req.on("data", chunk => { raw += chunk; }); req.on("end", () => {
      const body = JSON.parse(raw); captured = body;
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ output_text: JSON.stringify({ summary: "Use the red photo before the blue video", script: "Our story", scenes }) }));
    });
  });
  let captured;
  try {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=160x120", "-frames:v", "1", "-threads", "1", image]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=160x120:r=30:d=1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", movie]);
    const media = [{ ...photo, metadata: { filename: "IMG_001.png", sizeBytes: statSync(image).size } }, { ...video, metadata: { filename: "IMG_002.mp4", sizeBytes: statSync(movie).size } }, { ...photo, id: "large", metadata: { sizeBytes: 51 * 1024 ** 2 } }, { ...photo, id: "unknown", metadata: {} }];
    const staged = [];
    const frames = await sampleStoryFrames({ storage: { resolve: key => key.includes("video") ? movie : image, downloadToFile: async (key, path, options) => { assert.ok(options.signal); staged.push(key); const { copyFile } = await import("node:fs/promises"); await copyFile(key.includes("video") ? movie : image, path); } } }, media.map(a => ({ ...a, storageKey: a.id + ".media" })));
    assert.deepEqual(frames.map(f => [f.assetId, f.atS]), [["photo", 0], ["video", 0], ["video", 0.6]]);
    assert.equal(staged.length, 2); assert.ok(frames.every(f => Buffer.from(f.jpegBase64, "base64").subarray(0, 2).equals(Buffer.from([255, 216]))));
    await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
    const planned = await storyboardPlanner({ apiKey: "test", model: "vision-model", endpoint: "http://127.0.0.1:" + http.address().port })({ brief: "Tell a story", seconds: 10, assets: [], frames });
    assert.equal(planned.summary, "Use the red photo before the blue video");
    const content = captured.input[0].content;
    assert.equal(content.filter(c => c.type === "input_image").length, 3);
    assert.ok(content.some(c => c.type === "input_text" && c.text.includes("Asset video, frame at 0.60")));
    assert.equal(content[0].text.includes(frames[0].jpegBase64), false, "images are vision inputs, not base64 pasted into prompt text");
  } finally { if (http.listening) await new Promise(resolve => http.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
});
