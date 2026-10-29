import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepScratch } from "../dist/index.js";

test("sweepScratch removes only old entries with the given prefixes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-sweep-"));
  try {
    mkdirSync(join(dir, "videocraft-old")); writeFileSync(join(dir, "videocraft-old", "x"), "x");
    mkdirSync(join(dir, "videocraft-new")); mkdirSync(join(dir, "other-old"));
    const old = new Date(Date.now() - 2 * 86400_000);
    utimesSync(join(dir, "videocraft-old"), old, old); utimesSync(join(dir, "other-old"), old, old);
    assert.equal(await sweepScratch(dir, ["videocraft-"]), 1);
    assert.ok(!existsSync(join(dir, "videocraft-old")) && existsSync(join(dir, "videocraft-new")) && existsSync(join(dir, "other-old")));
    assert.equal(await sweepScratch(join(dir, "missing"), ["x"]), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
