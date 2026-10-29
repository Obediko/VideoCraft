import test from "node:test";
import assert from "node:assert/strict";
import { applyTimelineOperations } from "@videocraft/domain";
import { checkEdit, parseMediaSignals } from "../dist/index.js";

// Words every 0.4 s; sentences end every 6 words; a 3 s pause after word 17.
const words = []; let t = 0.5;
for (let i = 0; i < 36; i += 1) { const end = (i + 1) % 6 === 0; words.push({ text: "w" + i + (end ? "." : ""), startUs: Math.round(t * 1e6), endUs: Math.round((t + 0.25) * 1e6) }); t += i === 17 ? 3.4 : 0.4; }
const A = "11111111-1111-4111-8111-111111111111";
const durationUs = Math.round((t + 1) * 1e6);
const build = (ops) => applyTimelineOperations({ durationUs, tracks: [] }, ops);
const seg = (startS, endS) => ({ type: "insert-clip", assetId: A, sourceStartUs: Math.round(startS * 1e6), sourceEndUs: Math.round(endS * 1e6), reason: "r" });
const kinds = (issues) => issues.map((i) => i.kind);

test("finds a mid-word cut, a pause, a mid-sentence opening and ending; each fix resolves its issue", () => {
  // Starts inside w3 (mid-sentence too), runs across the long pause, ends inside w20.
  const timeline = build([seg(words[3].startUs / 1e6 + 0.1, words[20].startUs / 1e6 + 0.15)]);
  const issues = checkEdit({ timeline, assetId: A, words, sourceDurationUs: durationUs, platform: "youtube" });
  for (const k of ["mid-word", "dead-air", "opens-mid-sentence", "ends-mid-sentence"]) assert.ok(kinds(issues).includes(k), k + " in " + kinds(issues));
  for (const issue of issues.filter((i) => i.fix)) {
    const fixed = applyTimelineOperations(timeline, issue.fix.operations);
    assert.ok(!kinds(checkEdit({ timeline: fixed, assetId: A, words, sourceDurationUs: durationUs, platform: "youtube" })).includes(issue.kind) || issue.kind === "dead-air", issue.kind + " is resolved by its fix");
  }
  const pause = issues.find((i) => i.kind === "dead-air");
  const tightened = applyTimelineOperations(timeline, pause.fix.operations);
  const before = timeline.tracks[0].clips.reduce((s, c) => s + c.sourceEndUs - c.sourceStartUs, 0);
  const after = tightened.tracks.find((x) => x.kind === "video").clips.reduce((s, c) => s + c.sourceEndUs - c.sourceStartUs, 0);
  assert.ok(before - after > 2_500_000, "the pause is cut down to a beat");
});

test("a clean cut has nothing to fix", () => {
  const timeline = build([seg(words[0].startUs / 1e6 - 0.05, words[5].endUs / 1e6 + 0.05), seg(words[6].startUs / 1e6 - 0.05, words[11].endUs / 1e6 + 0.05)]);
  assert.deepEqual(checkEdit({ timeline, assetId: A, words, sourceDurationUs: durationUs, platform: "youtube" }).filter((i) => i.severity !== "info"), []);
});

test("graphics, music, captions and black frames", () => {
  const base = [seg(words[0].startUs / 1e6 - 0.05, words[11].endUs / 1e6 + 0.05)];
  const timeline = build([...base,
    { type: "add-graphic", kind: "title", text: "A very long title that will not fit on a phone screen at all", anchorAssetId: A, anchorSourceUs: 600_000, durationUs: 1_000_000 },
    { type: "add-graphic", kind: "callout", text: "Second", anchorAssetId: A, anchorSourceUs: 900_000, durationUs: 2_000_000 },
    { type: "set-music", assetId: "22222222-2222-4222-8222-222222222222", volumeDb: -6, duck: false }]);
  const issues = checkEdit({ timeline, assetId: A, words, sourceDurationUs: durationUs, platform: "tiktok", media: { black: [{ startUs: 0, endUs: 1_000_000 }], frozen: [] } });
  for (const k of ["graphics-overlap", "too-fast", "title-long", "music-loud", "no-captions", "black"]) assert.ok(kinds(issues).includes(k), k + " in " + kinds(issues));
  for (const issue of issues.filter((i) => i.fix)) assert.doesNotThrow(() => applyTimelineOperations(timeline, issue.fix.operations), issue.kind + " fix applies");
  const short = issues.find((i) => i.kind === "title-long").fix.operations[0].text;
  assert.ok(short.length <= 32 && /^A very long title/.test(short), short);
});

test("parses ffmpeg black and freeze detection with an offset", () => {
  const out = "[blackdetect @ 0x1] black_start:0.5 black_end:1.25 black_duration:0.75\n[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 2.2\nlavfi.freezedetect.freeze_duration: 1.8\nlavfi.freezedetect.freeze_end: 4\n";
  assert.deepEqual(parseMediaSignals(out, 10_000_000), { black: [{ startUs: 10_500_000, endUs: 11_250_000 }], frozen: [{ startUs: 12_200_000, endUs: 14_000_000 }] });
});

test("mostly-still footage gets one note, not a finding per pause in motion", () => {
  const timeline = build([seg(words[0].startUs / 1e6 - 0.05, words[11].endUs / 1e6 + 0.05)]);
  const frozen = [{ startUs: 0, endUs: 2_000_000 }, { startUs: 2_500_000, endUs: 5_000_000 }];
  const issues = checkEdit({ timeline, assetId: A, words, sourceDurationUs: durationUs, platform: "youtube", media: { black: [], frozen } });
  assert.deepEqual(issues.map((i) => i.kind), ["still"]);
  const one = checkEdit({ timeline, assetId: A, words, sourceDurationUs: durationUs, platform: "youtube", media: { black: [], frozen: [{ startUs: 2_000_000, endUs: 3_000_000 }] } });
  assert.deepEqual(one.map((i) => [i.kind, i.severity]), [["frozen", "warn"]]);
});
