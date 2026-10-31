import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { InMemoryAssetRepository, InMemoryProjectRepository, InMemoryRevisionRepository, ProjectService } from "@videocraft/application";
import { LocalObjectStorage } from "@videocraft/storage";
import { applyTimelineOperations } from "@videocraft/domain";
import { FfmpegCommandPlanner, FfmpegProcess } from "@videocraft/rendering";
import { registerCreationRoutes, storyTimeline, storyScenes } from "../dist/creation.js";

const photo = { id: "photo", projectId: "p", kind: "image", storageKey: "projects/p/assets/photo.media", checksumSha256: "a".repeat(64), metadata: { filename: "Photo.png" }, createdAt: "" };
const video = { ...photo, id: "video", kind: "video", durationUs: 1_200_000, metadata: { filename: "Video.mp4" } };
const voice = { ...photo, id: "voice", kind: "audio", durationUs: 3_600_000, metadata: { filename: "Human narration.wav" } };
const scenes = [{ assetId: "video", startS: 0, durationS: 1, text: "First", visual: "Blue clip" }, { assetId: "photo", startS: 0, durationS: 1, text: "Second", visual: "Red photo" }];

async function setup(plan) {
  const directory = mkdtempSync(join(tmpdir(), "vc-creation-"));
  const projects = new InMemoryProjectRepository(), assets = new InMemoryAssetRepository(), revisions = new InMemoryRevisionRepository();
  await projects.save({ id: "p", ownerId: "u", name: "Story", revision: 0, createdAt: "", updatedAt: "" });
  for (const a of [photo, video, voice]) await assets.save(a);
  const service = new ProjectService(projects, assets, revisions, { next: () => "id" }, { now: () => "2026-10-31T10:00:00Z" });
  let access = true, signedIn = true;
  const server = Fastify(); const storage = new LocalObjectStorage(directory);
  registerCreationRoutes(server, { projects, assets, revisions, storage, transcripts: { listForAsset: async () => [] }, authenticate: async () => signedIn ? { userId: "u" } : null, authorize: { canAccess: async () => access }, saveRevision: input => service.saveRevision(input), clock: () => "2026-10-31T10:00:00Z", ...(plan ? { plan } : {}) });
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
    const resolver = { resolve: async id => paths[id] ?? s.storage.resolve((await s.assets.listForProject("p")).find(a => a.id === id).storageKey), isStill: async id => id === "photo", hasAudio: async id => id !== "photo" };
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
  } finally { await s.close(); }
});
