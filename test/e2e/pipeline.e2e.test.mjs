// End-to-end pipeline test on real media: upload -> probe -> transcribe -> silence -> highlight
// proposal -> accept -> edit -> caption correction -> render (three formats) -> verify the output
// files by decoding them, re-transcribing them and comparing against ground truth.
//
// Needs FFmpeg plus the optional sherpa-onnx test assets (see test/e2e/README.md):
//   SHERPA_TTS_DIR, SHERPA_ASR_DIR, and `pip install sherpa-onnx numpy soundfile`.
// Without them the suite is skipped (it never silently passes).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../../apps/api/dist/server.js";
import { registerUploadRoutes } from "../../apps/api/dist/uploads.js";
import { registerTimelineRoutes } from "../../apps/api/dist/timeline-routes.js";
import { StorageSilenceDetector } from "../../apps/api/dist/media-analysis.js";
import { probeMedia } from "../../packages/analysis/dist/index.js";
import { FasterWhisperWorker } from "../../packages/transcription/dist/index.js";
import { LocalObjectStorage } from "../../packages/storage/dist/index.js";
import { FfmpegCommandPlanner, FfmpegProcess, PLATFORM_PRESETS } from "../../packages/rendering/dist/index.js";
import { StaticStrategyRegistry } from "../../packages/strategies/dist/index.js";
import { ProjectService, InMemoryAssetRepository, InMemoryProjectMemberRepository, InMemoryProjectRepository, InMemoryRevisionRepository, InMemorySceneRepository } from "../../packages/application/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const ready = process.env.SHERPA_TTS_DIR && process.env.SHERPA_ASR_DIR && spawnSync("python3", ["-c", "import sherpa_onnx, soundfile"]).status === 0;
const skip = ready ? false : "set SHERPA_TTS_DIR and SHERPA_ASR_DIR and install sherpa-onnx to run the real-media pipeline test";

const keepDir = process.env.E2E_KEEP_DIR;
const work = keepDir ? (mkdirSync(keepDir, { recursive: true }), keepDir) : mkdtempSync(join(tmpdir(), "vc-e2e-"));
const sec = (us) => us / 1e6;

test("real video: upload, understand, select highlights, edit, caption and export playable files", { skip, timeout: 15 * 60_000 }, async () => {
  try {
    // ---- 1. A real recording with known ground truth.
    const sample = join(work, "talk");
    execFileSync("python3", [join(here, "make_sample.py"), sample], { stdio: "pipe" });
    const truth = JSON.parse(readFileSync(sample + ".script.json", "utf8"));
    const topical = truth.sentences.filter((s) => s.topical);

    // ---- 2. The real API stack on a real HTTP port, with the production adapters.
    const mediaRoot = join(work, "media");
    mkdirSync(mediaRoot, { recursive: true });
    const storage = new LocalObjectStorage(mediaRoot);
    const projects = new InMemoryProjectRepository();
    const assets = new InMemoryAssetRepository();
    const revisions = new InMemoryRevisionRepository();
    const transcriptValues = new Map();
    const proposalValues = new Map();
    let n = 0;
    const ids = { next: () => "id-" + ++n };
    const clock = { now: () => new Date().toISOString() };
    const authenticate = async () => ({ userId: "user-1" });
    const authorize = { canAccess: async () => true };
    const service = new ProjectService(projects, assets, revisions, ids, clock);
    const server = buildServer({
      projects, assets, revisions, storage, members: new InMemoryProjectMemberRepository(), scenes: new InMemorySceneRepository(),
      authenticate: { authenticate }, authorize, strategies: new StaticStrategyRegistry(), clock, ids,
      transcripts: { async replaceForAsset(id, segs) { transcriptValues.set(id, segs); }, async listForAsset(id) { return transcriptValues.get(id) ?? []; } },
      proposals: { async save(p) { proposalValues.set(p.id, p); }, async get(id) { return proposalValues.get(id); }, async setStatus(id, status) { proposalValues.set(id, { ...proposalValues.get(id), status }); } },
      transcriber: new FasterWhisperWorker({ pythonCommand: "python3", workerPath: join(here, "sherpa_worker.py"), mediaRoot }),
      silenceDetector: new StorageSilenceDetector(storage),
    });
    registerUploadRoutes(server, { assets, storage, authorize, authenticate, clock: clock.now, inspector: (p) => probeMedia(p) });
    registerTimelineRoutes(server, { projects, revisions, authenticate, authorize, saveRevision: (i) => service.saveRevision(i) });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const base = "http://127.0.0.1:" + server.server.address().port;
    const call = async (method, path, body) => {
      const response = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    const upload = async (path, filename, bytes, type) => {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type }), filename);
      const response = await fetch(base + path, { method: "POST", body: form });
      return { status: response.status, body: await response.json() };
    };

    try {
      const { body: { project } } = await call("POST", "/v1/projects", { name: "E2E talk" });
      const projectId = project.id;

      // ---- 3. Ingestion: validation, duration and metadata.
      const junk = await upload("/v1/projects/" + projectId + "/assets/upload?kind=video", "fake.mp4", Buffer.from("this is not a video"), "video/mp4");
      assert.equal(junk.status, 422, "non-media is rejected: " + JSON.stringify(junk.body));
      const wrongKind = await upload("/v1/projects/" + projectId + "/assets/upload?kind=video", "tone.wav", readFileSync(sample + ".wav"), "audio/wav");
      assert.equal(wrongKind.status, 422, "audio-only file is not accepted as video");
      const uploaded = await upload("/v1/projects/" + projectId + "/assets/upload?kind=video", "talk.mp4", readFileSync(sample + ".mp4"), "video/mp4");
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      const asset = uploaded.body.asset;
      assert.ok(Math.abs(sec(asset.durationUs) - truth.durationS) < 0.3, "duration extracted: " + sec(asset.durationUs));
      assert.deepEqual([asset.metadata.width, asset.metadata.height, asset.metadata.hasAudio], [1280, 720, true]);

      // ---- 4. Automatic analysis: word-timed transcript and silence.
      const transcript = await call("POST", "/v1/projects/" + projectId + "/assets/" + asset.id + "/transcript");
      assert.equal(transcript.status, 201, JSON.stringify(transcript.body));
      const words = transcript.body.segments.flatMap((s) => s.words);
      assert.ok(words.length > 80, "word-timed transcript: " + words.length + " words");
      assert.match(words.map((w) => w.text).join(" ").toLowerCase(), /boarding/);
      const silences = await new StorageSilenceDetector(storage).detect(asset.storageKey);
      assert.ok(silences.some((s) => s.endUs - s.startUs > 1_500_000), "detects the long pauses in the recording");

      // ---- 5. Intelligent clip selection against goal / audience / platform.
      const fullClip = { id: "source", assetId: asset.id, sourceStartUs: 0, sourceEndUs: asset.durationUs, timelineStartUs: 0, timelineEndUs: asset.durationUs };
      const saved = await call("POST", "/v1/projects/" + projectId + "/revisions", { timeline: { durationUs: asset.durationUs, tracks: [{ id: "video", kind: "video", clips: [fullClip] }] } });
      assert.equal(saved.status, 201);
      const profile = { intent: "Explain why customer onboarding fails and how to fix it", audience: "SaaS founders", channel: "short-form", targetDurationUs: 30_000_000, constraints: [] };
      const preview = await call("POST", "/v1/projects/" + projectId + "/proposals", { revision: 1, strategyId: "highlight-reel", profile });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      const proposal = preview.body.proposal;
      const inserts = proposal.operations.filter((o) => o.type === "insert-clip");
      assert.ok(inserts.length >= 1);
      const keptUs = inserts.reduce((t, o) => t + o.sourceEndUs - o.sourceStartUs, 0);
      assert.ok(keptUs <= 33_000_000 && keptUs >= 10_000_000, "kept " + sec(keptUs) + "s for a 30s target");
      const overlapWith = (sentences) => inserts.reduce((total, o) => total + sentences.reduce((sum, s) => sum + Math.max(0, Math.min(o.sourceEndUs, s.endS * 1e6) - Math.max(o.sourceStartUs, s.startS * 1e6)), 0), 0);
      const onTopic = overlapWith(topical) / keptUs;
      assert.ok(onTopic >= 0.85, "at least 85% of the selected footage is on-topic, got " + onTopic.toFixed(2));
      // Explainability: reasons, scores and timestamped transcript evidence.
      assert.ok(inserts.every((o) => /score/.test(o.reason)));
      const evidence = proposal.evidence.filter((e) => e.source === "transcript");
      assert.ok(evidence.length >= 1 && evidence.every((e) => e.endUs > e.startUs && e.excerpt));
      assert.ok(evidence.some((e) => /boarding/i.test(e.excerpt)), "evidence quotes the relevant speech");

      // ---- 6. Accept, then edit the timeline: add a segment, reorder, remove, trim.
      const accepted = await call("POST", "/v1/projects/" + projectId + "/proposals/" + proposal.id + "/decision", { decision: "accepted" });
      assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
      let revision = accepted.body.revision;
      const clipsOf = (rev) => rev.timeline.tracks.find((t) => t.kind === "video").clips;
      const before = clipsOf(revision);
      assert.ok(revision.timeline.durationUs > 8_000_000);

      const wantedSentence = topical.find((s) => /Show people the value/.test(s.text));
      const alreadyHas = before.some((c) => c.sourceStartUs <= wantedSentence.startS * 1e6 && c.sourceEndUs >= wantedSentence.endS * 1e6);
      const ops = [];
      if (!alreadyHas) ops.push({ type: "insert-clip", assetId: asset.id, sourceStartUs: Math.round((wantedSentence.startS - 0.1) * 1e6), sourceEndUs: Math.round((wantedSentence.endS + 0.2) * 1e6), reason: "Added by editor: closing takeaway" });
      const edited1 = await call("POST", "/v1/projects/" + projectId + "/revisions/" + revision.revision + "/edit", { operations: ops.length ? ops : [{ type: "trim-clip", clipId: before[0].id, sourceStartUs: before[0].sourceStartUs, sourceEndUs: before[0].sourceEndUs - 200_000 }] });
      assert.equal(edited1.status, 201, JSON.stringify(edited1.body));
      revision = edited1.body.revision;
      const after1 = clipsOf(revision);
      if (after1.length > 1) {
        const reordered = await call("POST", "/v1/projects/" + projectId + "/revisions/" + revision.revision + "/edit", { operations: [{ type: "reorder-clips", clipIds: after1.map((c) => c.id).reverse() }] });
        assert.equal(reordered.status, 201, JSON.stringify(reordered.body));
        revision = reordered.body.revision;
        assert.deepEqual(clipsOf(revision).map((c) => c.sourceStartUs), after1.map((c) => c.sourceStartUs).reverse());
      }
      // Correct a caption (words are re-spelled but kept in sync with the audio).
      const cues = revision.timeline.tracks.find((t) => t.kind === "caption").clips;
      assert.ok(cues.length > 5);
      assert.ok(cues.every((c) => c.timelineEndUs <= revision.timeline.durationUs), "captions stay inside the timeline after editing");
      const target = cues.find((c) => /boarding/i.test(c.transform.text)) ?? cues[0];
      const fixedText = target.transform.text.replace(/on boarding/i, "onboarding");
      const corrected = await call("POST", "/v1/projects/" + projectId + "/revisions/" + revision.revision + "/edit", { operations: [{ type: "update-caption", clipId: target.id, text: fixedText + (fixedText === target.transform.text ? " " : "") }] });
      assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
      revision = corrected.body.revision;

      // ---- 7. Rendering: platform formats with captions, from the stored timeline.
      const planner = new FfmpegCommandPlanner({ resolve: async (id) => storage.resolve(assets.values.get(id).storageKey), hasAudio: async (id) => (await probeMedia(storage.resolve(assets.values.get(id).storageKey))).hasAudio });
      const outputs = {};
      for (const [name, settings] of [["tiktok", PLATFORM_PRESETS.tiktok.settings], ["youtube", PLATFORM_PRESETS.youtube.settings], ["tiktok-nocaptions", { ...PLATFORM_PRESETS.tiktok.settings, captionStyle: "none" }]]) {
        const out = join(work, name + ".mp4");
        await new FfmpegProcess().run(await planner.plan(revision, settings, out));
        outputs[name] = out;
      }

      // ---- 8. Verify the files themselves.
      const expectedS = sec(revision.timeline.durationUs);
      for (const [name, file] of Object.entries(outputs)) {
        const info = await probeMedia(file);
        assert.ok(info.hasAudio && info.hasVideo, name + " has audio and video");
        assert.ok(Math.abs(sec(info.durationUs) - expectedS) < 0.4, name + " duration " + sec(info.durationUs) + " vs " + expectedS);
        execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]); // full decode: playable end to end
      }
      const tiktok = await probeMedia(outputs.tiktok);
      assert.deepEqual([tiktok.width, tiktok.height], [1080, 1920]);
      const youtube = await probeMedia(outputs.youtube);
      assert.deepEqual([youtube.width, youtube.height], [1920, 1080]);

      // Captions are really burned in: the caption band differs between the captioned and plain renders.
      const ssim = spawnSync("ffmpeg", ["-hide_banner", "-i", outputs.tiktok, "-i", outputs["tiktok-nocaptions"], "-lavfi", "[0:v]crop=1080:600:0:1100[a];[1:v]crop=1080:600:0:1100[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
      const all = /All:([0-9.]+)/.exec(ssim.stderr)?.[1];
      assert.ok(all && Number(all) < 0.985, "caption band differs from the uncaptioned render (ssim " + all + ")");

      // The exported audio is the selected speech: re-transcribe the output and compare with the truth.
      const rt = spawnSync("python3", [join(here, "sherpa_worker.py")], { input: JSON.stringify({ assetPath: outputs.tiktok, assetId: "out" }) + "\n", encoding: "utf8", env: process.env });
      const heard = JSON.parse(rt.stdout).segments.map((s) => s.text).join(" ").toLowerCase();
      assert.match(heard, /boarding/, "exported video still contains the on-topic speech: " + heard);
      assert.doesNotMatch(heard, /oven|stream|watching/, "off-topic chatter was cut: " + heard);
      writeFileSync(join(work, "summary.json"), JSON.stringify({ expectedS, onTopic, heard, clips: clipsOf(revision).map((c) => ({ sourceS: [sec(c.sourceStartUs), sec(c.sourceEndUs)], reason: c.reason })), evidence: proposal.evidence, captions: revision.timeline.tracks.find((t) => t.kind === "caption").clips.slice(0, 6).map((c) => ({ at: [sec(c.timelineStartUs), sec(c.timelineEndUs)], text: c.transform.text })) }, null, 1));
    } finally {
      await server.close();
    }
  } finally {
    if (!keepDir) rmSync(work, { recursive: true, force: true });
  }
});
