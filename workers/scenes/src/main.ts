import { readFile } from "node:fs/promises";
import { detect, ContentDetector } from "scenedetect";

for await (const line of readLines()) {
  try {
    const request = JSON.parse(line);
    if (typeof request.inputPath !== "string") throw new Error("inputPath is required");
    const scenes = detect(request.inputPath, ContentDetector());
    process.stdout.write(JSON.stringify({
      scenes: scenes.map((scene, index) => ({
        id: "scene-" + index,
        startUs: Math.round(scene[0].get_seconds() * 1_000_000),
        endUs: Math.round(scene[1].get_seconds() * 1_000_000),
      })),
    }) + "\n");
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  }
}

async function* readLines() {
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield line;
  }
  if (buffer.trim()) yield buffer;
}
