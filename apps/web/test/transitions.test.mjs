import test from "node:test";
import assert from "node:assert/strict";
import { clipFinish } from "@videocraft/rendering";
import { veilAt } from "../test-dist/preview.js";

// The export's fades for each clip, read from the FFmpeg filters the renderer writes.
function exportVeil(clips, tUs) {
  const i = clips.findIndex((c) => tUs >= c.timelineStartUs && tUs < c.timelineEndUs);
  const clip = clips[i]; const len = (clip.timelineEndUs - clip.timelineStartUs) / 1e6; const local = (tUs - clip.timelineStartUs) / 1e6;
  let best = { opacity: 0, color: "#000" };
  for (const m of clipFinish(clips, i, len).matchAll(/fade=t=(in|out):st=([\d.]+):d=([\d.]+):color=(black|white)/g)) {
    const [, dir, st, d] = m; const colour = m[4] === "black" ? "#000" : "#fff";
    const opacity = dir === "in" ? (local < Number(d) ? 1 - local / Number(d) : 0) : local >= Number(st) ? Math.min(1, (local - Number(st)) / Number(d)) : 0;
    if (opacity > best.opacity) best = { opacity, color: colour };
  }
  return best;
}
const clip = (id, start, length, transform) => ({ id, assetId: "a", sourceStartUs: start, sourceEndUs: start + length, timelineStartUs: start, timelineEndUs: start + length, transform });

test("the live preview's transitions match the export, including short clips and explicit endings", () => {
  const edits = [
    // Short clips: fades last at most a third of the clip.
    [clip("a", 0, 450_000, { transitionIn: "dip-black" }), clip("b", 450_000, 300_000, { transitionIn: "dip-white" }), clip("c", 750_000, 2_000_000, { transitionIn: "flash" })],
    // An explicit fade-out to white before a clip that dips in from black: each side keeps its own colour.
    [clip("a", 0, 2_000_000, { transitionOut: "dip-white" }), clip("b", 2_000_000, 2_000_000, { transitionIn: "dip-black", transitionOut: "dip-black" })],
    // A flash never fades the clip before it; a dip does.
    [clip("a", 0, 1_000_000, {}), clip("b", 1_000_000, 1_000_000, { transitionIn: "flash" }), clip("c", 2_000_000, 1_000_000, { transitionIn: "dip-black" })],
  ];
  for (const clips of edits) {
    const end = clips[clips.length - 1].timelineEndUs;
    for (let t = 0; t < end; t += 10_000) {
      const want = exportVeil(clips, t); const got = veilAt(clips, t, end);
      assert.ok(Math.abs(want.opacity - got.opacity) < 0.02, "opacity at " + t / 1e6 + "s: export " + want.opacity.toFixed(3) + ", preview " + got.opacity.toFixed(3) + " in " + JSON.stringify(clips.map((c) => c.transform)));
      if (want.opacity > 0.02) assert.equal(got.color, want.color, "colour at " + t / 1e6 + "s");
    }
  }
});
