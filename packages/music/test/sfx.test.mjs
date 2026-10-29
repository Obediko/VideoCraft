import test from "node:test";
import assert from "node:assert/strict";
import { generateSoundEffect } from "../dist/index.js";

for (const kind of ["whoosh", "pop", "hit", "riser"]) {
  test("sound effect " + kind + " is audible, bounded and click-free", () => {
    const { left, right, sampleRate } = generateSoundEffect(kind);
    assert.equal(sampleRate, 48_000);
    let peak = 0, energy = 0;
    for (let i = 0; i < left.length; i += 1) { peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i])); energy += left[i] ** 2; }
    assert.ok(peak > 0.6 && peak <= 0.71, "peak " + peak);
    assert.ok(Math.sqrt(energy / left.length) > 0.03, "has body");
    assert.ok(Math.abs(left[0]) < 1e-3 && Math.abs(left.at(-1)) < 1e-3, "starts and ends at silence");
  });
}
test("the whoosh travels from left to right", () => {
  const { left, right } = generateSoundEffect("whoosh");
  const half = left.length / 2; let l1 = 0, r1 = 0, l2 = 0, r2 = 0;
  for (let i = 0; i < left.length; i += 1) { if (i < half) { l1 += left[i] ** 2; r1 += right[i] ** 2; } else { l2 += left[i] ** 2; r2 += right[i] ** 2; } }
  assert.ok(l1 / r1 > 1 && r2 / l2 > 1);
});
