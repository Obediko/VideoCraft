import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { VoiceoverDependencies } from "./voiceover.js";

/** Generated visuals are ordinary stored assets, so preview and export use exactly the approved image. */
export function registerGeneratedMediaRoutes(server: FastifyInstance, d: Omit<VoiceoverDependencies, "fetch"> & { fetch?: typeof fetch; imageModel?: string; imageInspector(path: string): Promise<boolean> }): void {
  server.get("/v1/projects/:projectId/creation/capabilities", async (request, reply) => {
    const principal = await d.authenticate(request);
    if (!principal) return reply.code(401).send({ error: { message: "Authentication required" } });
    const { projectId } = request.params as { projectId: string };
    if (!(await d.authorize.canAccess(principal, projectId, "editor"))) return reply.code(403).send({ error: { message: "Project access denied" } });
    return { images: Boolean(d.apiKey && d.imageModel), generatedVideo: false };
  });
  server.post("/v1/projects/:projectId/creation/image", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } } as never, async (request, reply) => {
    const principal = await d.authenticate(request);
    if (!principal) return reply.code(401).send({ error: { message: "Authentication required" } });
    const { projectId } = request.params as { projectId: string };
    if (!(await d.authorize.canAccess(principal, projectId, "editor"))) return reply.code(403).send({ error: { message: "Project access denied" } });
    if (!d.apiKey || !d.imageModel) return reply.code(503).send({ error: { message: "Image generation is not configured. Upload an image or choose stock instead." } });
    const b = (request.body ?? {}) as { prompt?: unknown };
    if (typeof b.prompt !== "string" || b.prompt.trim().length < 3 || b.prompt.length > 2000) return reply.code(400).send({ error: { message: "Describe an image in 3 to 2000 characters" } });
    const directory = await mkdtemp(join(tmpdir(), "videocraft-image-"));
    try {
      const response = await (d.fetch ?? fetch)((d.endpoint ?? "https://api.openai.com/v1").replace(/\/$/, "") + "/images/generations", {
        method: "POST", signal: AbortSignal.timeout(90_000), headers: { authorization: "Bearer " + d.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ model: d.imageModel, prompt: b.prompt.trim(), n: 1, size: "1024x1024", output_format: "png" }),
      });
      if (!response.ok) throw new Error("Image generation failed (provider " + response.status + "). Try stock or upload a visual.");
      const body = await response.json() as { data?: Array<{ b64_json?: string }> };
      const encoded = body.data?.[0]?.b64_json;
      if (!encoded || encoded.length > 28_000_000) throw new Error("The image service returned no usable image");
      const data = Buffer.from(encoded, "base64");
      if (data.length < 8 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("The image service returned an invalid PNG");
      const path = join(directory, "image.png"); await writeFile(path, data);
      if (!(await d.imageInspector(path))) throw new Error("The generated image could not be decoded");
      const id = randomUUID(); const stored = await d.storage.putFile(path, "projects/" + projectId + "/assets/" + id + ".media");
      const asset = { id, projectId, kind: "image" as const, storageKey: stored.key, checksumSha256: stored.checksumSha256, metadata: { filename: "Generated image.png", mimeType: "image/png", sizeBytes: stored.size, generated: true, generationModel: d.imageModel, prompt: b.prompt.trim() }, createdAt: d.clock() };
      await d.assets.save(asset);
      return reply.code(201).send({ asset });
    } catch (err) {
      request.log.warn({ err, projectId }, "Image generation failed");
      return reply.code(502).send({ error: { message: err instanceof Error ? err.message : "Image generation failed" } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
