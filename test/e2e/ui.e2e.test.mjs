// Drives the real browser UI against the real API stack and a real video: sign up, upload, transcribe,
// find highlights, accept, edit (move/trim), correct a caption, scrub the source, and render a 9:16 export.
// Same prerequisites as pipeline.e2e.test.mjs plus a Chromium (PLAYWRIGHT_CHROMIUM or /opt/pw-browsers).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildServer } from "../../apps/api/dist/server.js";
import { registerUploadRoutes } from "../../apps/api/dist/uploads.js";
import { registerTimelineRoutes } from "../../apps/api/dist/timeline-routes.js";
import { registerRenderRoutes } from "../../apps/api/dist/render-routes.js";
import { registerMediaRoutes } from "../../apps/api/dist/media-routes.js";
import { registerPreferenceRoutes } from "../../apps/api/dist/learning.js";
import { StorageSilenceDetector } from "../../apps/api/dist/media-analysis.js";
import { isStillImage, probeMedia } from "../../packages/analysis/dist/index.js";
import { FasterWhisperWorker } from "../../packages/transcription/dist/index.js";
import { LocalObjectStorage } from "../../packages/storage/dist/index.js";
import { FfmpegCommandPlanner, FfmpegProcess } from "../../packages/rendering/dist/index.js";
import { StaticStrategyRegistry } from "../../packages/strategies/dist/index.js";
import { ProjectService, InMemoryPreferenceRepository, InMemoryAssetRepository, InMemoryProjectMemberRepository, InMemoryProjectRepository, InMemoryRevisionRepository, InMemorySceneRepository } from "../../packages/application/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync("/opt/pw-browsers") ? readdirSync("/opt/pw-browsers").filter((d) => /^chromium-\d+$/.test(d)).map((d) => join("/opt/pw-browsers", d, "chrome-linux/chrome")).find(existsSync) : undefined);
const ready = process.env.SHERPA_TTS_DIR && process.env.SHERPA_ASR_DIR && chromiumPath && spawnSync("python3", ["-c", "import sherpa_onnx, soundfile"]).status === 0;
const skip = ready ? false : "needs SHERPA_TTS_DIR, SHERPA_ASR_DIR, sherpa-onnx and a Chromium (see test/e2e/README.md)";

test("real browser: upload a talk, get explained highlights, edit, fix a caption and export 9:16", { skip, timeout: 15 * 60_000 }, async () => {
  const work = process.env.E2E_KEEP_DIR ? (mkdirSync(process.env.E2E_KEEP_DIR + "-ui", { recursive: true }), process.env.E2E_KEEP_DIR + "-ui") : mkdtempSync(join(tmpdir(), "vc-ui-"));
  const sample = join(work, "talk");
  execFileSync("python3", [join(here, "make_sample.py"), sample], { stdio: "pipe" });

  // The production web bundle, built for same-origin API calls and served by the test server itself.
  const dist = join(work, "web-dist");
  const build = spawnSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: join(root, "apps/web"), env: { ...process.env, VITE_API_BASE_URL: "" }, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr + build.stdout);

  const mediaRoot = join(work, "media");
  mkdirSync(mediaRoot, { recursive: true });
  const storage = new LocalObjectStorage(mediaRoot);
  const projects = new InMemoryProjectRepository();
  const assets = new InMemoryAssetRepository();
  const revisions = new InMemoryRevisionRepository();
  const transcriptValues = new Map();
  const proposalValues = new Map();
  const jobs = new Map();
  let n = 0;
  const ids = { next: () => "id-" + ++n };
  const clock = { now: () => new Date().toISOString() };
  const authenticate = async () => ({ userId: "user-1" });
  const authorize = { canAccess: async () => true };
  const preferences = new InMemoryPreferenceRepository();
  const service = new ProjectService(projects, assets, revisions, ids, clock);
  const jobRepository = { get: async (id) => jobs.get(id), save: async (job) => { jobs.set(job.id, job); }, update: async (job) => { jobs.set(job.id, job); } };
  const renderer = {
    async enqueue({ project, revision, settings, idempotencyKey }) {
      const job = { id: "render-" + ++n, projectId: project.id, revision: revision.revision, settings, idempotencyKey, status: "running", progress: 10 };
      jobs.set(job.id, job);
      void (async () => {
        const key = "projects/" + project.id + "/renders/" + job.id + ".mp4";
        const out = storage.resolve(key);
        mkdirSync(dirname(out), { recursive: true });
        const pathOf = async (assetId) => storage.resolve((await assets.listForProject(project.id)).find((a) => a.id === assetId).storageKey);
        const planner = new FfmpegCommandPlanner({ resolve: pathOf, hasAudio: async (assetId) => (await probeMedia(await pathOf(assetId))).hasAudio, isStill: async (assetId) => isStillImage(await pathOf(assetId)).catch(() => false) });
        await new FfmpegProcess().run(await planner.plan(revision, settings, out));
        jobs.set(job.id, { ...job, status: "succeeded", progress: 100, output: { storageKey: key, mimeType: "video/mp4", sizeBytes: 1, checksumSha256: "x" } });
      })().catch((error) => jobs.set(job.id, { ...job, status: "failed", progress: 0, errorMessage: String(error) }));
      return job;
    },
  };
  const server = buildServer({
    projects, assets, revisions, storage, members: new InMemoryProjectMemberRepository(), scenes: new InMemorySceneRepository(),
    authenticate: { authenticate }, authorize, strategies: new StaticStrategyRegistry(), clock, ids, renderer, preferences,
    transcripts: { async replaceForAsset(id, segs) { transcriptValues.set(id, segs); }, async listForAsset(id) { return transcriptValues.get(id) ?? []; } },
    proposals: { async save(p) { proposalValues.set(p.id, p); }, async get(id) { return proposalValues.get(id); }, async setStatus(id, status) { proposalValues.set(id, { ...proposalValues.get(id), status }); } },
    transcriber: new FasterWhisperWorker({ pythonCommand: "python3", workerPath: join(here, "sherpa_worker.py"), mediaRoot }),
    silenceDetector: new StorageSilenceDetector(storage),
  });
  registerUploadRoutes(server, { assets, storage, authorize, authenticate, clock: clock.now, inspector: (p) => probeMedia(p), imageInspector: (p) => isStillImage(p) });
  registerTimelineRoutes(server, { projects, revisions, preferences, assets, authenticate, authorize, saveRevision: (i) => service.saveRevision(i) });
  registerRenderRoutes(server, { jobs: jobRepository, storage, signingSecret: "test-signing-secret-test-signing", authenticate, authorize });
  registerPreferenceRoutes(server, { preferences, authenticate });
  registerMediaRoutes(server, { assets, storage, signingSecret: "test-signing-secret-test-signing", authenticate, authorize });
  server.post("/auth/register", async (request, reply) => reply.code(201).send({ user: { id: "user-1", email: request.body.email }, accessToken: "test-token" }));
  server.post("/auth/refresh", async (_request, reply) => reply.code(401).send({ error: { code: "no_session", message: "No session" } }));
  server.get("/", async (_request, reply) => reply.type("text/html").send(readFileSync(join(dist, "index.html"))));
  server.get("/assets/:file", async (request, reply) => {
    const file = request.params.file;
    if (!/^[\w.-]+$/.test(file) || !existsSync(join(dist, "assets", file))) return reply.code(404).send();
    return reply.type(file.endsWith(".css") ? "text/css" : "text/javascript").send(readFileSync(join(dist, "assets", file)));
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const base = "http://127.0.0.1:" + server.server.address().port;

  const browser = await chromium.launch({ executablePath: chromiumPath, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const status = () => page.locator(".status-pill").innerText();
    const waitStatus = async (pattern, timeout = 120_000) => {
      try { await page.locator(".status-pill").filter({ hasText: pattern }).waitFor({ timeout }); }
      catch (error) { throw new Error("waiting for " + pattern + "; status is \"" + (await status()) + "\"; jobs " + JSON.stringify([...jobs.values()].map((j) => [j.status, j.progress, j.errorMessage?.slice(0, 300)])) + "; " + error.message.split("\n")[0]); }
    };

    await page.goto(base + "/");
    await page.getByRole("button", { name: "Create account" }).first().click();
    await page.getByLabel("Email").fill("founder@example.com");
    await page.getByLabel("Password").fill("a-long-password-1");
    await page.getByRole("button", { name: "Create account" }).last().click();
    await waitStatus(/Account created/);

    await page.getByRole("button", { name: "Create project" }).click();
    await waitStatus(/Project created/);
    await page.locator('input[type="file"]').setInputFiles(sample + ".mp4");
    await waitStatus(/Uploaded asset/);
    assert.deepEqual(errors, [], "no page errors after upload");

    await page.getByRole("button", { name: "Transcribe" }).click();
    await waitStatus(/Transcribed \d+ segments \(\d+ timed words\)/);
    await page.getByRole("button", { name: "Add video clip" }).click();
    await page.getByRole("button", { name: "Save revision" }).click();
    await waitStatus(/Revision 1 saved/);

    await page.getByLabel("Intent").fill("Explain why customer onboarding fails and how to fix it");
    await page.getByLabel("Audience").fill("SaaS founders");
    await page.getByLabel("Target length (seconds)").fill("30");
    await page.getByRole("button", { name: "Find highlights" }).click();
    await page.locator(".highlight-list li").first().waitFor({ timeout: 60_000 });
    const reasons = await page.locator(".highlight-list li").allInnerTexts();
    assert.ok(reasons.length >= 1 && reasons.every((text) => /score \d+/.test(text) && /Highlight \d+\/\d+/.test(text)), "every suggestion explains itself: " + reasons.join(" | "));
    const evidence = await page.locator(".evidence code").allInnerTexts();
    assert.ok(evidence.some((text) => /\d+\.\ds–\d+\.\ds/.test(text)), "evidence carries timestamps: " + evidence.join(" | "));

    await page.getByRole("button", { name: "Accept as revision" }).click();
    await waitStatus(/Proposal accepted/);
    const clips = page.locator("button.clip");
    await clips.first().waitFor();
    const videoClipCount = await page.locator(".track", { has: page.locator(".track-label", { hasText: /^video$/ }) }).locator("button.clip").count();
    assert.ok(videoClipCount >= 1);

    // Editing through the UI: select, move, trim, remove nothing yet.
    const videoClips = page.locator(".track", { has: page.locator(".track-label", { hasText: /^video$/ }) }).locator("button.clip");
    await videoClips.first().click();
    const before = await page.getByText(/of source/).first().innerText();
    await page.getByRole("button", { name: "Trim end −0.5s" }).click();
    await waitStatus(/Clip trimmed \(revision \d+\)/);
    const after = await page.getByText(/of source/).first().innerText();
    assert.notEqual(before, after, "trim changed the clip range: " + before + " -> " + after);
    if (videoClipCount > 1) { await page.getByRole("button", { name: "Move later" }).click(); await waitStatus(/Clip moved later \(revision \d+\)/); }

    // Caption correction.
    const cueInput = page.locator(".cue-list input").first();
    const original = await cueInput.inputValue();
    await cueInput.fill(original + " FIXED");
    await page.locator(".cue-list button").first().click();
    await waitStatus(/Caption corrected/);
    assert.match(await page.locator(".cue-list input").first().inputValue(), /FIXED$/);

    // Background music: upload a track and lay it under the cut.
    const song = join(work, "song.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=300:d=8", song]);
    await page.locator('label:has-text("Upload media") select').selectOption("audio");
    await page.locator('input[type="file"]').setInputFiles(song);
    await waitStatus(/Uploaded asset/);
    await page.getByLabel("Music track").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Add music" }).click();
    await waitStatus(/Music set \(revision \d+\)/);
    await page.locator(".music-panel").filter({ hasText: /Playing song\.wav at -16 dB, ducked under speech/ }).waitFor({ timeout: 10_000 });

    // B-roll: upload a still and cut away to it on the selected clip.
    const still = join(work, "cutaway.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=800x600:d=1", "-frames:v", "1", still]);
    await page.locator('label:has-text("Upload media") select').selectOption("image");
    await page.locator('input[type="file"]').setInputFiles(still);
    await waitStatus(/Uploaded asset/);
    await videoClips.first().click();
    await page.getByLabel("B-roll media").selectOption({ label: "image · cutaway.png" });
    await page.getByLabel("On screen for (seconds)").fill("2");
    await page.getByRole("button", { name: "Add B-roll at playhead" }).click();
    await waitStatus(/B-roll added.*\(revision \d+\)/);
    await page.locator(".broll-list li").filter({ hasText: /cutaway\.png · full/ }).waitFor({ timeout: 10_000 });

    // The source player serves the uploaded video with seeking.
    await page.getByRole("tab", { name: "Source" }).click();
    const player = page.locator(".preview-screen video");
    await player.waitFor({ timeout: 30_000 });
    const playbackUrl = await player.getAttribute("src");
    assert.match(playbackUrl, /\/assets\/[^/]+\/media\?expires=\d+&signature=/, "the player is given a signed, expiring URL");
    const ranged = await fetch(base + playbackUrl, { headers: { range: "bytes=0-99" } });
    assert.equal(ranged.status, 206, "byte-range seeking is supported");
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    // Playwright's open-source Chromium has no H.264 decoder, so decoding is asserted only where the browser can.
    const canDecode = await page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== "");
    if (canDecode) {
      await page.waitForFunction(() => { const v = document.querySelector(".preview-screen video"); return v && v.readyState >= 1 && v.duration > 50; }, null, { timeout: 30_000 });
      await videoClips.first().click();
      await page.getByRole("button", { name: "Play selected clip" }).click();
      await page.waitForFunction(() => { const v = document.querySelector(".preview-screen video"); return v && !v.paused && v.currentTime > 0; }, null, { timeout: 30_000 });
    } else console.log("# note: this Chromium cannot decode H.264; in-browser playback was not exercised");

    // Export for a 9:16 platform and verify the file the browser is offered.
    await page.getByLabel("Platform").selectOption("tiktok");
    await page.getByRole("button", { name: "Render preview" }).click();
    await waitStatus(/Render succeeded/, 240_000);
    const src = await page.locator(".preview-screen video").getAttribute("src");
    assert.ok(src, "rendered export is offered for playback");
    const bytes = Buffer.from(await (await fetch(src.startsWith("http") ? src : base + src)).arrayBuffer());
    const outPath = join(work, "ui-export.mp4");
    execFileSync("sh", ["-c", "cat > " + JSON.stringify(outPath)], { input: bytes });
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", outPath]).toString());
    const video = probe.streams.find((s) => s.codec_type === "video");
    assert.deepEqual([video.width, video.height], [1080, 1920]);
    assert.ok(probe.streams.some((s) => s.codec_type === "audio"), "export carries the mixed speech and music");
    // The b-roll still is in the export: some frame of the first second-ish of the cut is red.
    const frameColour = (t) => [...execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", outPath, "-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).subarray(0, 3)];
    const window = (await page.locator(".broll-list li span").first().innerText()).match(/([\d.]+)s–([\d.]+)s/);
    assert.ok(window, "b-roll window is listed");
    const mid = (Number(window[1]) + Number(window[2])) / 2;
    const [r, g, b] = frameColour(mid);
    assert.ok(r > 150 && g < 90 && b < 90, "the b-roll still is on screen at " + mid + "s in the export: " + [r, g, b]);
    const [r0, g0, b0] = frameColour(Math.max(0, Number(window[1]) - 0.5) === Number(window[1]) ? Number(window[2]) + 0.5 : Math.max(0, Number(window[1]) - 0.5));
    assert.ok(!(r0 > 150 && g0 < 90 && b0 < 90), "and not outside its window: " + [r0, g0, b0]);
    assert.ok(Number(probe.format.duration) > 10 && Number(probe.format.duration) < 45, "duration " + probe.format.duration);
    execFileSync("ffmpeg", ["-v", "error", "-i", outPath, "-f", "null", "-"]);

    // Exporting teaches the highlight finder; the editor shows what it learned and can reset it.
    const learnedPanel = page.locator(".learned-panel");
    await learnedPanel.filter({ hasText: /[1-9]\d* exported/ }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Reset what was learned" }).click();
    await waitStatus(/Learned preferences cleared/);
    await learnedPanel.filter({ hasText: /^[\s\S]*0 signals/ }).waitFor({ timeout: 15_000 });
    assert.deepEqual(errors, [], "no page errors during the session: " + errors.join(" | ") + " | " + (await status()));
  } finally {
    await browser.close();
    await server.close();
    if (!process.env.E2E_KEEP_DIR) rmSync(work, { recursive: true, force: true });
  }
});
