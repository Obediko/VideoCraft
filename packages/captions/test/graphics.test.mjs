import test from "node:test";
import assert from "node:assert/strict";
import { assColour, renderGraphicsAss } from "../dist/index.js";

test("graphics ASS: animated events, colours and escaping", () => {
  assert.equal(assColour("#112233"), "332211");
  assert.equal(assColour("nope"), assColour(undefined));
  const ass = renderGraphicsAss([
    { kind: "title", text: "Why {onboarding} fails", subtitle: "3 fixes", startUs: 1_000_000, endUs: 3_000_000, color: "#00FF00" },
    { kind: "lower-third", text: "Ada Obi", subtitle: "Founder", startUs: 4_000_000, endUs: 7_000_000 },
  ], { startUs: 0, endUs: 8_000_000, color: "#0000FF" }, { width: 1080, height: 1920 });
  const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  assert.equal(events.length, 1 + 1 + 3, "progress + title + bar/name/role");
  assert.match(events[0], /\\fscx0\\t\(0,8000,\\fscx100\)/, "progress fills over the whole 8s");
  assert.match(events[0], /\\1c&HFF0000&/, "progress colour in BGR");
  const title = events.find((e) => /,Title,/.test(e));
  assert.match(title, /0:00:01\.00,0:00:03\.00/);
  assert.match(title, /\\3c&H00FF00&.*\\t\(0,220,\\fscx100\\fscy100\).*\\fad\(160,/, "accent box + pop + fade");
  assert.match(title, /Why \(onboarding\) fails\\N/, "braces neutralised, subtitle on a new line");
  const name = events.find((e) => /,Name,/.test(e));
  assert.match(name, /\\move\(-540,\d+,\d+,\d+,60,330\)/, "name slides in from the left");
});

test("graphics stay out of the caption band", async () => {
  const { captionBand, CAPTION_STYLES } = await import("../dist/index.js");
  const band = captionBand(CAPTION_STYLES["bold-pop"], 1920);
  assert.ok(band.topY > 900 && band.bottomY === 1344, JSON.stringify(band));
  const ass = renderGraphicsAss([
    { kind: "lower-third", text: "Ada", subtitle: "Founder", startUs: 0, endUs: 2_000_000 },
    { kind: "callout", text: "Key point", position: "bottom", startUs: 0, endUs: 2_000_000 },
  ], undefined, { width: 1080, height: 1920 }, { avoid: band });
  const ys = [...ass.matchAll(/\\move\(-?\d+,(\d+),\d+,(\d+)/g)].map((m) => Number(m[2]));
  const callY = Number(ass.match(/\\pos\(540,(\d+)\)/)[1]);
  assert.ok(ys.length >= 2 && ys.every((y) => y < band.topY), "lower third above captions: " + ys + " vs " + band.topY);
  assert.ok(callY < band.topY, "bottom callout lifted above captions: " + callY);
  const free = renderGraphicsAss([{ kind: "lower-third", text: "Ada", startUs: 0, endUs: 2_000_000 }], undefined, { width: 1080, height: 1920 });
  assert.ok(Math.max(...[...free.matchAll(/\\move\(-?\d+,(\d+),\d+,(\d+)/g)].map((m) => Number(m[2]))) > band.topY, "without captions it keeps its usual lower position");
});
