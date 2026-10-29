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
import { registerMusicRoutes } from "../../apps/api/dist/music-routes.js";
import { registerDirectorRoutes } from "../../apps/api/dist/director-routes.js";
import { RuleDirector } from "../../packages/director/dist/index.js";
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
  registerMusicRoutes(server, { assets, revisions, storage, authenticate, authorize, clock: clock.now });
  registerDirectorRoutes(server, { projects, assets, revisions, storage, transcripts: { listForAsset: async (id) => transcriptValues.get(id) ?? [] }, director: new RuleDirector(), saveRevision: (i) => service.saveRevision(i), authenticate, authorize, clock: clock.now });
  registerMediaRoutes(server, { assets, storage, signingSecret: "test-signing-secret-test-signing", authenticate, authorize });
  let registeredEmail = "";
  server.post("/auth/register", async (request, reply) => { registeredEmail = request.body.email; return reply.code(201).send({ user: { id: "user-1", email: registeredEmail }, accessToken: "test-token" }); });
  // Like the real refresh cookie: once signed up, a reload restores the session.
  server.post("/auth/refresh", async (_request, reply) => registeredEmail ? reply.send({ user: { id: "user-1", email: registeredEmail }, accessToken: "test-token" }) : reply.code(401).send({ error: { code: "no_session", message: "No session" } }));
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
    await page.locator(".segmented").getByRole("tab", { name: "Create account" }).click();
    await page.getByLabel("Email").fill("founder@example.com");
    await page.getByLabel("Password").fill("a-long-password-1");
    await page.locator(".auth-card").getByRole("button", { name: "Create account" }).click();
    await waitStatus(/Account created/);

    // Videos → New video → upload: transcription starts by itself.
    await page.getByLabel("Name for the new video").fill("Onboarding talk");
    await page.getByRole("button", { name: "New video" }).click();
    await waitStatus(/Project created/);
    await page.getByRole("heading", { name: "What is this video for?" }).waitFor();
    await page.getByLabel("Upload a video").setInputFiles(sample + ".mp4");
    await waitStatus(/Uploaded talk\.mp4/);
    await page.locator(".checklist li.ok", { hasText: /Transcribed: \d+ words/ }).waitFor({ timeout: 180_000 });
    assert.deepEqual(errors, [], "no page errors after upload");

    // A reload brings the person back to the same video and step.
    await page.reload();
    await page.getByRole("heading", { name: "What is this video for?" }).waitFor({ timeout: 20_000 });
    assert.match(await page.locator(".video-card").innerText(), /talk\.mp4/, "the uploaded video is still there after a reload");
    const shot = async (name) => { if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, name + ".png"), fullPage: true }); };
    await shot("describe");

    // Planning with an empty description is refused; the classic highlights path works without one.
    assert.equal(await page.getByRole("button", { name: "Make the first cut" }).isDisabled(), true, "the first cut needs a description");
    await page.getByLabel("Description").fill("A 30 second clip explaining why customer onboarding fails and how to fix it, for SaaS founders");
    await page.getByRole("button", { name: "Just find the highlights" }).click();
    await waitStatus(/Highlights ready: review the \d+ suggested highlights?/, 180_000);
    const reasons = await page.locator(".highlight-list li").allInnerTexts();
    assert.ok(reasons.length >= 1 && reasons.every((text) => /score \d+/.test(text) && /Highlight \d+\/\d+/.test(text)), "every suggestion explains itself: " + reasons.join(" | "));
    await shot("highlights");
    await page.locator(".proposal-panel summary", { hasText: "Evidence" }).click();
    const evidence = await page.locator(".evidence code").allInnerTexts();
    assert.ok(evidence.some((text) => /\d+\.\ds–\d+\.\ds/.test(text)), "evidence carries timestamps: " + evidence.join(" | "));
    await page.getByRole("button", { name: "Accept highlights" }).click();
    await waitStatus(/Proposal accepted/);

    // The editor: modes on the left, transcript, preview, timeline. No sideways scrolling.
    await page.getByRole("navigation", { name: "Editing modes" }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal page scroll in the editor");
    const storyClips = page.locator(".track", { has: page.locator(".track-label", { hasText: /^Story$/ }) }).locator("button.clip");
    await storyClips.first().waitFor();
    const clipCount = await storyClips.count();

    // Story mode: cut words in the transcript, then bring them back.
    const keptWord = page.locator(".words .word:not(.cut)").nth(3);
    const lastWord = page.locator(".words .word:not(.cut)").nth(5);
    const cutBefore = await page.locator(".words .word.cut").count();
    await keptWord.click();
    await lastWord.click({ modifiers: ["Shift"] });
    await page.locator(".selection-bar").getByRole("button", { name: "Cut", exact: true }).click();
    await waitStatus(/^Cut “/);
    assert.equal(await page.locator(".words .word.cut").count(), cutBefore + 3, "exactly the three selected words are struck through");
    // Select the same stretch again and bring it back.
    const words = page.locator(".words .word");
    const indexOfFirstCut = await words.evaluateAll((els) => els.map((e, i) => (e.classList.contains("cut") ? i : -1)).filter((i) => i >= 0));
    const fresh = indexOfFirstCut.find((i, k, all) => all[k + 1] === i + 1 && all[k + 2] === i + 2 && !all.includes(i - 1));
    await words.nth(fresh).click();
    await words.nth(fresh + 2).click({ modifiers: ["Shift"] });
    await page.locator(".selection-bar").getByRole("button", { name: "Bring back" }).click();
    await waitStatus(/^Brought back “/);
    assert.equal(await page.locator(".words .word.cut").count(), cutBefore, "the words are back in the cut");

    // Clip tools in the inspector: trim and move.
    await storyClips.first().click();
    const before = await page.locator(".inspector .mono").innerText();
    await page.getByRole("button", { name: "Trim end −0.5s" }).click();
    await waitStatus(/Clip trimmed \(revision \d+\)/);
    assert.notEqual(before, await page.locator(".inspector .mono").innerText(), "the trim changed the clip");
    if (clipCount > 1) { await storyClips.first().click(); await page.getByRole("button", { name: "Move later" }).click(); await waitStatus(/Clip moved later \(revision \d+\)/); }

    // Captions & text: correct a caption, add a title, then a progress bar in the brand colour.
    await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByLabel("Accent colour for titles and the progress bar").fill("#00ff00");
    await page.getByRole("button", { name: "Captions", exact: true }).click();
    const cueInput = page.locator(".cue-list input").first();
    const original = await cueInput.inputValue();
    await cueInput.fill(original + " FIXED");
    await page.locator(".cue-list button").first().click();
    await waitStatus(/Caption corrected/);
    assert.match(await page.locator(".cue-list input").first().inputValue(), /FIXED$/);
    await page.locator(".graphics-panel").getByLabel("Text", { exact: true }).fill("Why onboarding fails");
    await page.getByRole("button", { name: "Add at the playhead" }).click();
    await waitStatus(/Title added.*\(revision \d+\)/);
    const gfxInput = page.locator(".graphics-list input").first();
    await gfxInput.fill("Why onboarding really fails");
    await page.locator(".graphics-list li").first().getByRole("button", { name: "Save" }).click();
    await waitStatus(/Text updated/);
    await page.getByLabel("Progress bar across the top").click();
    await waitStatus(/Progress bar on/);
    assert.equal(await page.getByLabel("Progress bar across the top").isChecked(), true);

    // Audio: compose a matching bed for this cut.
    await page.getByRole("button", { name: "Audio", exact: true }).click();
    const musicPanel = page.locator(".music-panel");
    await musicPanel.getByLabel("Mood").selectOption("inspiring");
    await musicPanel.getByRole("button", { name: "Generate matching music" }).click();
    await waitStatus(/Music added: Inspiring · .* BPM .*\(revision \d+\)/, 60_000);
    await musicPanel.filter({ hasText: /Playing Generated inspiring 96 BPM\.wav \(inspiring, .* major, 96 BPM\) at -16 dB, lowered while people speak/ }).waitFor({ timeout: 10_000 });
    assert.ok(await musicPanel.getByRole("button", { name: "Try different music" }).isVisible(), "a second click tries different music");
    await musicPanel.getByLabel("Sound effect").selectOption("whoosh");
    await page.getByRole("button", { name: "Add sound at the playhead" }).click();
    await waitStatus(/Whoosh added/);

    // Visuals: upload a still, cut away to it, punch in on the first clip, warm look on everything.
    await page.getByRole("button", { name: "Visuals", exact: true }).click();
    const still = join(work, "cutaway.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=800x600:d=1", "-frames:v", "1", still]);
    await page.getByLabel("Upload a photo or clip").setInputFiles(still);
    await waitStatus(/Uploaded cutaway\.png/);
    await storyClips.first().click();
    await page.getByLabel("Cutaway media").selectOption({ label: "Photo · cutaway.png" });
    await page.locator(".broll-panel").getByLabel("On screen for (seconds)").fill("2");
    await page.locator(".broll-panel").getByRole("button", { name: "Add at the playhead" }).click();
    await waitStatus(/Cutaway added.*\(revision \d+\)/);
    await page.locator(".broll-list li").filter({ hasText: /cutaway\.png · full/ }).waitFor({ timeout: 10_000 });
    await storyClips.first().click();
    await page.locator(".clip-effects").getByLabel("Zoom").selectOption("punch");
    await waitStatus(/Zoom: Punch in/);
    await page.getByLabel("Look for the whole video").selectOption("warm");
    await waitStatus(/Look: Warm/);
    const chipsNow = (await page.locator(".track button.clip strong").allInnerTexts()).join(" | ");
    assert.match(chipsNow, /punch-in/); assert.match(chipsNow, /Sound · Whoosh/); assert.match(chipsNow, /talk\.mp4/, "clips are labelled with the file name");
    const ticks = await page.locator(".ruler-lane span").allInnerTexts();
    assert.ok(ticks.length >= 3 && ticks[0] === "00:00", "ruler ticks: " + ticks.join(","));

    // The live preview draws the edit over the footage: scrub to the title and it is on screen with a caption.
    await page.getByRole("button", { name: "Captions", exact: true }).click();
    const titleStart = Number((await page.locator(".graphics-list li .mono").first().innerText()).replace("s", ""));
    await page.getByRole("tab", { name: "Edit" }).click();
    const live = page.locator(".live");
    await live.waitFor();
    await page.evaluate((ms) => { const input = document.querySelector('.live-controls input[type="range"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, String(ms)); input.dispatchEvent(new Event("input", { bubbles: true })); }, Math.round((titleStart + 0.3) * 1000));
    await live.locator(".live-title", { hasText: "Why onboarding really fails" }).waitFor({ timeout: 5_000 });
    await shot("live");
    const seekLive = (ms) => page.evaluate((v) => { const input = document.querySelector('.live-controls input[type="range"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, String(v)); input.dispatchEvent(new Event("input", { bubbles: true })); }, ms);
    await seekLive(300);
    await page.waitForFunction(() => /scale\(1\.12/.test(document.querySelector(".live-video")?.getAttribute("style") ?? ""), null, { timeout: 5_000 });
    assert.match(await live.locator(".live-video").getAttribute("style") ?? "", /sepia/, "and the warm look");
    assert.ok(await live.locator(".live-progress").count() === 1, "the progress bar is drawn");
    // The source player serves the uploaded video with seeking.
    await page.getByRole("tab", { name: "Original" }).click();
    const player = page.locator(".preview-screen video");
    await player.waitFor({ timeout: 30_000 });
    const playbackUrl = await player.getAttribute("src");
    assert.match(playbackUrl, /\/assets\/[^/]+\/media\?expires=\d+&signature=/, "the player is given a signed, expiring URL");
    const ranged = await fetch(base + playbackUrl, { headers: { range: "bytes=0-99" } });
    assert.equal(ranged.status, 206, "byte-range seeking is supported");
    const canDecode = await page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== "");
    if (!canDecode) console.log("# note: this Chromium cannot decode H.264; in-browser playback was not exercised");

    // Review mode → the check; apply its fixes (a trim can clip a word), then export.
    await page.getByRole("button", { name: /^Review/ }).click();
    await waitStatus(/Check done: /, 120_000);
    const checkPanel = page.locator(".check-panel");
    const late = await checkPanel.locator(".issue-list li").allInnerTexts();
    console.log("# edit check: " + late.map((f) => f.replace(/\s+/g, " ")).join(" | "));
    if (await checkPanel.getByRole("button", { name: "Apply selected fixes" }).isEnabled().catch(() => false)) {
      const checkedBefore = await checkPanel.getAttribute("data-checked-revision");
      await checkPanel.getByRole("button", { name: "Apply selected fixes" }).click();
      await page.waitForFunction((before) => document.querySelector(".check-panel")?.getAttribute("data-checked-revision") !== before, checkedBefore, { timeout: 120_000 });
      await waitStatus(/Check done: /, 120_000);
      const lateAfter = await checkPanel.locator(".issue-list li").allInnerTexts();
      assert.ok(lateAfter.filter((f) => /^\s*Fix\b/.test(f)).length < late.filter((f) => /^\s*Fix\b/.test(f)).length, "applying fixes clears them");
    }
    await shot("check");
    await page.getByRole("button", { name: "Go to export" }).click();
    await page.getByRole("heading", { name: "Export", exact: true }).waitFor();
    await page.getByLabel(/Reel \/ Short \/ TikTok/).check();
    await page.getByRole("button", { name: "Export video" }).click();
    await waitStatus(/Render succeeded/, 240_000);
    assert.equal(await page.getByRole("link", { name: "Download video" }).getAttribute("download"), "videocraft-export.mp4");
    const src = await page.locator(".preview-screen video").getAttribute("src");
    const bytes = Buffer.from(await (await fetch(src.startsWith("http") ? src : base + src)).arrayBuffer());
    const outPath = join(work, "ui-export.mp4");
    execFileSync("sh", ["-c", "cat > " + JSON.stringify(outPath)], { input: bytes });
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", outPath]).toString());
    const video = probe.streams.find((s) => s.codec_type === "video");
    assert.deepEqual([video.width, video.height], [1080, 1920]);
    assert.ok(probe.streams.some((s) => s.codec_type === "audio"), "export carries the mixed speech and music");
    const duration = Number(probe.format.duration);
    const topRows = execFileSync("ffmpeg", ["-v", "error", "-ss", String(duration / 2), "-i", outPath, "-frames:v", "1", "-vf", "crop=1080:6:0:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    let greenPixels = 0;
    for (let i = 0; i < topRows.length; i += 3) if (topRows[i + 1] > 180 && topRows[i] < 100 && topRows[i + 2] < 100) greenPixels += 1;
    assert.ok(Math.abs(greenPixels / (topRows.length / 3) - 0.5) < 0.1, "progress bar ~50% at the midpoint: " + greenPixels / (topRows.length / 3));
    assert.ok(duration > 10 && duration < 45, "duration " + duration);
    execFileSync("ffmpeg", ["-v", "error", "-i", outPath, "-f", "null", "-"]);
    // Exporting teaches the highlight finder; the export page shows what it learned and can reset it.
    await page.locator(".learned-panel summary").click();
    await page.locator(".learned-panel").filter({ hasText: /[1-9]\d* exported/ }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Reset what was learned" }).click();
    await waitStatus(/Learned preferences cleared/);

    // The AI director path (built-in rules director here): describe, review the grouped plan, apply.
    await page.getByRole("button", { name: /Describe/ }).click();
    await page.getByLabel("Description").fill("A 20 second upbeat YouTube clip for SaaS founders about fixing onboarding");
    await page.getByRole("button", { name: "Make the first cut" }).click();
    await waitStatus(/Plan ready: \d+ suggestions/, 120_000);
    await shot("plan");
    const director = page.locator(".director-panel");
    const groups = (await director.locator(".group-title").allInnerTexts()).join(" | ");
    for (const group of ["Story", "Text on screen", "Look", "Sound", "Format"]) assert.match(groups, new RegExp(group, "i"), "plan grouped by outcome: " + groups);
    const titleItem = director.locator(".suggestion", { has: page.locator("strong", { hasText: /title/i }) }).first();
    await titleItem.locator('input:not([type="checkbox"])').fill("Fix onboarding in a week");
    await director.locator(".suggestion", { has: page.locator("strong", { hasText: /^Export for/ }) }).locator('input[type="checkbox"]').uncheck();
    await page.getByRole("button", { name: "Apply the selected" }).click();
    await waitStatus(/Plan applied \(revision \d+\)\. Music: Upbeat/, 120_000);
    await page.getByRole("navigation", { name: "Editing modes" }).waitFor();
    const overlayChips = (await page.locator(".track", { has: page.locator(".track-label", { hasText: /^Text$/ }) }).locator("button.clip strong").allInnerTexts()).join(" | ");
    assert.match(overlayChips, /Fix onboarding in a week/, "the edited title text is used: " + overlayChips);

    // Ask for a change in plain words; the suggestions are ticked and applied like the plan.
    await page.getByRole("textbox", { name: "Ask" }).fill("make it 10 seconds and black and white");
    await page.getByRole("button", { name: "Go" }).click();
    await waitStatus(/Suggested 2 changes/, 60_000);
    await page.locator(".ask-result").getByRole("button", { name: "Apply" }).click();
    await waitStatus(/^Changed \(revision \d+\)/, 60_000);
    const storySeconds = await page.locator(".track", { has: page.locator(".track-label", { hasText: /^Story$/ }) }).locator("button.clip small").allInnerTexts();
    const keptSeconds = storySeconds.reduce((sum, t) => sum + Number(t.replace("s", "")), 0);
    assert.ok(keptSeconds <= 12.5, "about 10 s after asking: " + keptSeconds);

    // Everything fits the window at laptop, large-screen and phone sizes.
    for (const [w, h] of [[1366, 768], [1920, 1080], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(300);
      const layout = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll(".card, .topbar, .pane, .inspector, .timeline, .page, .mode-rail")) if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== "auto") bad.push((el.className || el.tagName) + " " + el.scrollWidth + ">" + el.clientWidth);
        return { extra: document.documentElement.scrollWidth - window.innerWidth, bad };
      });
      if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "ui-" + w + "x" + h + ".png"), fullPage: true });
      assert.ok(layout.extra <= 1, w + "x" + h + ": page is " + layout.extra + "px wider than the window");
      assert.deepEqual(layout.bad, [], w + "x" + h + ": overflowing panels");
    }
    await page.setViewportSize({ width: 1500, height: 1100 });

    // Delete the project from the project menu: the name must be typed back.
    const menu = page.locator("details.menu", { has: page.locator('summary[aria-label="Project menu"]') });
    if (!(await menu.evaluate((d) => d.open))) await page.locator('summary[aria-label="Project menu"]').click();
    if (!(await menu.evaluate((d) => d.open))) await page.locator('summary[aria-label="Project menu"]').click();
    const deleteButton = page.locator(".danger-zone").getByRole("button", { name: "Delete project" });
    await deleteButton.waitFor();
    assert.equal(await deleteButton.isDisabled(), true, "disabled until the name is typed");
    await page.getByLabel("Type the project name to confirm").fill("ONBOARDING TALK");
    await deleteButton.click();
    await waitStatus(/^Deleted “Onboarding talk”/);
    await page.getByRole("heading", { name: "Your videos" }).waitFor({ timeout: 15_000 });
    assert.equal(await projects.get("id-1"), undefined, "the project is gone on the server");
    assert.deepEqual(await assets.listForProject("id-1"), [], "and so are its assets");
    await page.reload();
    await page.getByRole("heading", { name: "Your videos" }).waitFor({ timeout: 20_000 });
    await shot("projects");

    assert.deepEqual(errors, [], "no page errors during the session: " + errors.join(" | ") + " | " + (await status()));
  } finally {
    await browser.close();
    await server.close();
    if (!process.env.E2E_KEEP_DIR) rmSync(work, { recursive: true, force: true });
  }
});
