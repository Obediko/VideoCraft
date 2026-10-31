import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "vc-story-browser-"));
let media: Buffer;
try {
  const path = join(directory, "video.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]);
  media = readFileSync(path);
} finally { rmSync(directory, { recursive: true, force: true }); }
const photo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

async function setup(page: Page) {
  const state = { creates: 0, uploads: 0, assets: [] as any[], revision: 0, timeline: { durationUs: 0, tracks: [] } as any, applied: null as any, transcripts: 0, generated: 0, plans: 0, photoFails: false, photoRequests: 0, voiceRequests: 0 };
  const project = () => ({ id: "p", name: "New story", revision: state.revision, createdAt: "2026-10-31", updatedAt: "2026-10-31" });
  await page.route("http://localhost:8080/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const headers = { "access-control-allow-origin": req.headers().origin ?? "http://127.0.0.1:5173", "access-control-allow-credentials": "true", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type, range" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (path === "/photo.png") {
      state.photoRequests++;
      return route.fulfill({ status: state.photoFails ? 503 : 200, headers: { ...headers, "cache-control": "no-store" }, contentType: state.photoFails ? "text/plain" : "image/png", body: state.photoFails ? Buffer.from("temporary failure") : photo });
    }
    if (path === "/video.mp4") {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers().range ?? "");
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
      return route.fulfill({ status: range ? 206 : 200, headers: { ...headers, "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${media.length}` } : {}) }, contentType: "video/mp4", body: media.subarray(start, end + 1) });
    }
    let body: any = {};
    if (path === "/auth/refresh") body = { accessToken: "test-token", user: { email: "creator@example.com" } };
    else if (path === "/v1/projects" && req.method() === "POST") { state.creates++; body = { project: project() }; }
    else if (path === "/v1/projects") body = { projects: state.creates ? [project()] : [] };
    else if (path === "/v1/projects/p/assets") body = { assets: state.assets };
    else if (path.endsWith("/assets/upload")) {
      state.uploads++;
      const kind = new URL(req.url()).searchParams.get("kind");
      const asset = { id: "a" + state.uploads, kind, durationUs: kind === "audio" ? 3_600_000 : kind === "video" ? 3_000_000 : undefined, storageKey: "", metadata: { filename: kind === "audio" ? "Human narration.wav" : "Upload " + state.uploads } };
      state.assets.push(asset); body = { asset };
    } else if (path.endsWith("/creation/capabilities")) body = { images: true, generatedVideo: false };
    else if (path.endsWith("/creation/plan")) {
      state.plans++;
      const input = req.postDataJSON();
      body = { plan: { source: "ai", summary: "A clear story", script: "Jesus truly saves.", scenes: input.assetIds.length ? input.assetIds.map((id: string) => ({ assetId: id, startS: 0, durationS: 0.8, text: "", visual: "Visual for " + id })) : [{ assetId: "", startS: 0, durationS: 1, text: "", visual: "Sunrise" }] } };
    } else if (path.endsWith("/creation/image")) {
      state.generated++; const asset = { id: "generated", kind: "image", metadata: { filename: "Generated image.png", generated: true } }; state.assets.push(asset); body = { asset };
    } else if (path.endsWith("/creation/apply")) {
      state.applied = req.postDataJSON(); state.revision++;
      let at = 0;
      state.timeline = { durationUs: 0, tracks: [{ id: "video", kind: "video", clips: state.applied.scenes.map((s: any, i: number) => { const start = at; at += s.durationS * 1e6; return { id: "c" + i, assetId: s.assetId, sourceStartUs: s.startS * 1e6, sourceEndUs: (s.startS + s.durationS) * 1e6, timelineStartUs: start, timelineEndUs: at, transform: { background: "none" } }; }) }] }; state.timeline.durationUs = at;
      body = { platform: "tiktok", revision: { revision: state.revision, timeline: state.timeline, tailoring: { intent: "A story", constraints: ["creation:story"] } } };
    } else if (path.endsWith("/voiceover/speech")) {
      state.voiceRequests++;
      const input = req.postDataJSON(); const asset = { id: "aiVoice", kind: "audio", durationUs: 3_600_000, metadata: { filename: "AI narration.mp3", voiceover: true, script: input.text } }; state.assets.push(asset); body = { asset };
    } else if (path.endsWith("/voiceover/voices")) body = { voices: ["marin"] };
    else if (path.endsWith("/stock/sources")) body = { video: ["pexels"], photo: ["pexels"], gif: [] };
    else if (path.endsWith("/stock/search")) body = { items: [{ provider: "pexels", id: "stock", kind: "photo", thumbUrl: "http://localhost:8080/photo.png", width: 100, height: 100, title: "Sunrise", credit: "Photographer" }] };
    else if (path.endsWith("/stock/import")) { const asset = { id: "stock", kind: "image", metadata: { filename: "Sunrise.png" } }; state.assets.push(asset); body = { asset }; }
    else if (path.endsWith("/playback-url")) body = { url: path.includes("a2") ? "http://localhost:8080/video.mp4" : "http://localhost:8080/photo.png" };
    else if (path.endsWith("/transcript")) { if (req.method() === "POST") state.transcripts++; body = { segments: [] }; }
    else if (/\/revisions\/\d+$/.test(path)) body = { revision: { revision: state.revision, timeline: state.timeline, tailoring: { intent: "A story", constraints: ["creation:story"] } } };
    else if (path.endsWith("/renders")) body = { jobs: [] };
    await route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/");
  return state;
}

test("choose the purpose before creating a project; mixed uploads, draft recovery, reorder and photo-to-video playback work on a phone", async ({ page }) => {
  const state = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "New video", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What do you want to create?" })).toBeVisible();
  expect(state.creates).toBe(0);
  await page.getByRole("button", { name: /^Tell a story/ }).click();
  await page.getByLabel("Your brief").fill("Tell our mentoring story");
  await page.getByLabel("Upload videos and photos", { exact: true }).setInputFiles([{ name: "photo.png", mimeType: "image/png", buffer: photo }, { name: "video.mp4", mimeType: "video/mp4", buffer: media }]);
  await expect.poll(() => state.uploads).toBe(2);
  await page.getByRole("button", { name: "Make my storyboard" }).click();
  await expect(page.getByRole("heading", { name: "3. Review the storyboard" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Your brief")).toHaveValue("Tell our mentoring story");
  await expect(page.getByRole("heading", { name: "3. Review the storyboard" })).toBeVisible();
  await page.getByRole("button", { name: "Move scene 2 earlier" }).click();
  await page.getByRole("button", { name: "Assemble this story" }).click();
  await expect(page.getByLabel("Live preview of the edit")).toBeVisible();
  expect(state.applied.scenes.map((s: any) => s.assetId)).toEqual(["a2", "a1"]);
  await expect.poll(() => page.locator("video.live-video").evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Play the edit", exact: true }).click();
  await expect(page.getByAltText("Storyboard photo")).toBeVisible();
  await expect.poll(() => page.getByRole("button", { name: "Play the edit", exact: true }).count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Open storyboard", exact: true })).toBeVisible();
});

test("an idea with no uploads requires an approved visual; stock and generated images enter the editable storyboard", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "New video", exact: true }).click();
  await page.getByRole("button", { name: /^Create from an idea or script/ }).click();
  await page.getByLabel("Your brief").fill("A hopeful sunrise story");
  await page.getByRole("button", { name: "Make my storyboard" }).click();
  await expect(page.getByRole("button", { name: "Assemble this story" })).toBeDisabled();
  await page.getByRole("button", { name: "Preview / find visuals for scene 1" }).click();
  await page.getByLabel("Search stock").fill("sunrise");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Add Sunrise from Pexels" }).click();
  await expect(page.getByLabel("Visual", { exact: true })).toHaveValue("stock");
  await page.getByRole("button", { name: "Generate image", exact: true }).click();
  await expect(page.getByLabel("Visual", { exact: true })).toHaveValue("generated");
  expect(state.generated).toBe(1);
  state.photoFails = true;
  await page.getByRole("button", { name: "Assemble this story" }).click();
  await expect(page.getByLabel("Live preview of the edit")).toBeVisible();
  // A new document avoids reusing the decoded image already shown while choosing visuals.
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("The photo could not be loaded");
  state.photoFails = false;
  await page.getByRole("button", { name: "Reload footage", exact: true }).click();
  await expect.poll(() => page.getByAltText("Storyboard photo").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.applied.scenes[0].assetId).toBe("generated");
});

test("human narration is uploaded separately and transcription is requested before assembling captions", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "New video", exact: true }).click();
  await page.getByRole("button", { name: /^Tell a story/ }).click();
  await page.getByLabel("Your brief").fill("A narrated photo story");
  await page.getByLabel("Upload videos and photos", { exact: true }).setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: photo });
  await page.getByRole("button", { name: "Make my storyboard" }).click();
  await page.getByLabel("Upload human narration").setInputFiles({ name: "narration.wav", mimeType: "audio/wav", buffer: Buffer.from("recorded narration fixture") });
  await expect(page.getByLabel("Narration", { exact: true })).toHaveValue("a2");
  await page.getByRole("button", { name: "Assemble this story" }).click();
  await expect(page.getByLabel("Live preview of the edit")).toBeVisible();
  expect(state.applied.narrationAssetId).toBe("a2"); expect(state.applied.captions).toBe(true); expect(state.transcripts).toBe(1);
});


test("AI narration uses the reviewed script and the resulting audio asset is selected for assembly", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "New video", exact: true }).click();
  await page.getByRole("button", { name: /^Tell a story/ }).click();
  await page.getByLabel("Your brief").fill("A narrated photo story");
  await page.getByLabel("Upload videos and photos", { exact: true }).setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: photo });
  await page.getByRole("button", { name: "Make my storyboard" }).click();
  await expect(page.getByLabel("Or type what to say")).toHaveValue("Jesus truly saves.");
  await page.getByRole("button", { name: "Add this voice-over", exact: true }).click();
  await expect(page.getByLabel("Narration", { exact: true })).toHaveValue("aiVoice");
  await page.getByRole("button", { name: "Assemble this story" }).click();
  await expect(page.getByLabel("Live preview of the edit")).toBeVisible();
  expect(state.voiceRequests).toBe(1); expect(state.applied.narrationAssetId).toBe("aiVoice");
  expect(state.assets.find(a => a.id === "aiVoice").metadata.script).toBe("Jesus truly saves.");
});
