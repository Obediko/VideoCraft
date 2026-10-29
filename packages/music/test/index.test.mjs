import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOODS, encodeWav, generateMusic, inferMood } from "../dist/index.js";

const mono = (r) => { const x = new Float32Array(r.left.length); for (let i = 0; i < x.length; i += 1) x[i] = (r.left[i] + r.right[i]) / 2; return x; };
function tempo(x, sr, skipS = 4) {
  const hop = 441; const e = [];
  for (let i = Math.floor(skipS * sr); i + 1024 < x.length; i += hop) { let s = 0; for (let j = 0; j < 1024; j += 1) s += x[i + j] ** 2; e.push(Math.log(s + 1e-9)); }
  const o = e.slice(1).map((v, i) => Math.max(0, v - e[i])); const m = o.reduce((a, b) => a + b, 0) / o.length; const c = o.map((v) => v - m);
  let best = 0; let bestLag = 0;
  for (let lag = Math.round((60 / 180) * sr / hop); lag <= Math.round(sr / hop); lag += 1) { let s = 0; for (let i = 0; i + lag < c.length; i += 1) s += c[i] * c[i + lag]; if (s > best) { best = s; bestLag = lag; } }
  return 60 / (bestLag * hop / sr);
}

test("every mood renders at the exact length with headroom and its stated tempo", () => {
  for (const mood of MOODS) {
    const r = generateMusic({ mood, durationS: 20, seed: 11, sampleRate: 22_050 });
    assert.equal(r.left.length, 20 * 22_050, mood + " length");
    let peak = 0; for (const v of [...r.left, ...r.right]) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak <= 0.892 && peak > 0.8, mood + " peak at about -1 dBFS: " + peak);
    assert.ok(Number.isFinite(peak));
    assert.match(r.description, new RegExp(r.bpm + " BPM"));
    if (mood !== "calm") { const t = tempo(mono(r), 22_050); const ok = [0.5, 1, 2].some((k) => Math.abs(t * k - r.bpm) <= 4); assert.ok(ok, mood + " measured " + t.toFixed(1) + " BPM vs " + r.bpm); }
  }
});

test("the same seed gives the same music; another seed gives different music", () => {
  const a = generateMusic({ mood: "upbeat", durationS: 6, seed: 5, sampleRate: 16_000 });
  const b = generateMusic({ mood: "upbeat", durationS: 6, seed: 5, sampleRate: 16_000 });
  const c = generateMusic({ mood: "upbeat", durationS: 6, seed: 6, sampleRate: 16_000 });
  assert.deepEqual(a.left, b.left);
  assert.notDeepEqual(a.left, c.left);
});

test("cut points get an audible lift; the intro and outro are quieter than the groove", () => {
  const sr = 22_050;
  const rms = (x, from, to) => { let s = 0; const a = Math.floor(from * sr), z = Math.floor(to * sr); for (let i = a; i < z; i += 1) s += x[i] ** 2; return Math.sqrt(s / (z - a)); };
  // Measured relative to the same track's previous bars: peak normalisation makes absolute levels misleading.
  for (const mood of MOODS) {
    const rel = (x) => rms(x, 14.6, 15.2) / rms(x, 11, 14);
    const plain = mono(generateMusic({ mood, durationS: 30, seed: 2, sampleRate: sr }));
    const lifted = mono(generateMusic({ mood, durationS: 30, seed: 2, sampleRate: sr, accentsS: [15] }));
    assert.ok(rel(lifted) / rel(plain) > 1.12, mood + " lifts into the cut at 15s: " + (rel(lifted) / rel(plain)).toFixed(2));
  }
  const upbeat = mono(generateMusic({ mood: "upbeat", durationS: 40, seed: 2, sampleRate: sr }));
  assert.ok(rms(upbeat, 0.5, 3) < rms(upbeat, 10, 20), "intro quieter than the groove");
});

test("moods are inferred from the brief", () => {
  assert.equal(inferMood("A calm devotional reflection"), "calm");
  assert.equal(inferMood("Professional update for investors"), "serious");
  assert.equal(inferMood("Inspire graduates to start their journey"), "inspiring");
  assert.equal(inferMood("A funny clip for kids"), "playful");
  assert.equal(inferMood("Product launch promo"), "upbeat");
  assert.equal(inferMood("Pick the most engaging moments", "short-form"), "upbeat");
  assert.equal(inferMood("Pick the most engaging moments", "youtube"), "calm");
});

test("WAV output is valid and decodes to the right length", () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-music-"));
  try {
    const r = generateMusic({ mood: "inspiring", durationS: 4, seed: 1 });
    const path = join(dir, "m.wav");
    writeFileSync(path, encodeWav(r.left, r.right, r.sampleRate));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]).toString());
    assert.equal(probe.streams[0].codec_name, "pcm_s16le");
    assert.equal(probe.streams[0].channels, 2);
    assert.equal(Number(probe.streams[0].sample_rate), 44_100);
    assert.ok(Math.abs(Number(probe.format.duration) - 4) < 0.01);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
