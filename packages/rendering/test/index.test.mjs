import test from "node:test";
import assert from "node:assert/strict";
import { FfmpegCommandPlanner } from "../dist/index.js";

test("FFmpeg plan uses argv without a shell", async () => {
  const planner = new FfmpegCommandPlanner({ resolve: async () => "/media/source.mp4" });
  const plan = await planner.plan({
    projectId: "p",
    revision: 1,
    timeline: { durationUs: 10_000_000, tracks: [{
      id: "track",
      kind: "video",
      clips: [{ id: "clip", assetId: "asset", sourceStartUs: 0, sourceEndUs: 5_000_000, timelineStartUs: 0, timelineEndUs: 5_000_000 }]
    }]},
    acceptedProposalIds: [],
    createdAt: "",
    createdBy: "u"
  }, { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1281, height: 721, frameRate: 30 }, "/renders/output.mp4");
  assert.equal(plan.args.includes("scale=1280:720:force_original_aspect_ratio=decrease"), true);
  assert.equal(plan.args.includes("/media/source.mp4"), true);
});

test("planner rejects multiple video clips until the concat worker is implemented", async () => {
  const planner = new FfmpegCommandPlanner({ resolve: async () => "/media/source.mp4" });
  await assert.rejects(() => planner.plan({
    projectId: "p", revision: 1, timeline: { durationUs: 10, tracks: [{
      id: "track", kind: "video", clips: [
        { id: "a", assetId: "asset", sourceStartUs: 0, sourceEndUs: 1, timelineStartUs: 0, timelineEndUs: 1 },
        { id: "b", assetId: "asset", sourceStartUs: 1, sourceEndUs: 2, timelineStartUs: 1, timelineEndUs: 2 }
      ]
    }]}, acceptedProposalIds: [], createdAt: "", createdBy: "u"
  }, { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 }, "/out.mp4"), /exactly one/);
});


test("FFmpeg plan renders bounded caption tracks", async () => {
  const planner = new FfmpegCommandPlanner({ resolve: async () => "/media/source.mp4" });
  const plan = await planner.plan({
    projectId: "p",
    revision: 1,
    timeline: {
      durationUs: 5_000_000,
      tracks: [
        { id: "track", kind: "video", clips: [{ id: "clip", assetId: "asset", sourceStartUs: 0, sourceEndUs: 5_000_000, timelineStartUs: 0, timelineEndUs: 5_000_000 }] },
        { id: "captions", kind: "caption", clips: [{ id: "caption", assetId: "generated:caption", sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000, transform: { text: "For founders: launch, learn" } }] }
      ]
    },
    acceptedProposalIds: [], createdAt: "", createdBy: "u"
  }, { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 }, "/renders/output.mp4");
  const filter = plan.args[plan.args.indexOf("-vf") + 1];
  assert.match(filter, /drawtext=/);
  assert.match(filter, /For founders\\: launch\\, learn/);
  assert.match(filter, /between\(t,0\.000000,2\.000000\)/);
});
