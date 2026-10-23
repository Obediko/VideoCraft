import type { TailoringProfile } from "@videocraft/domain";

export interface RerankCandidate { id: string; text: string; startUs: number; endUs: number; }
export interface RerankResult { scores: Array<{ id: string; relevance: number; reason: string }>; model: string; }

/** Judges how well each candidate clip serves the goal, audience and platform (0..1), with a short reason. */
export interface HighlightReranker { rerank(input: { profile: TailoringProfile; candidates: RerankCandidate[] }): Promise<RerankResult>; }

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export interface OpenAiCompatibleRerankerOptions { endpoint: string; apiKey: string; model: string; timeoutMs?: number; maxPerMinute?: number; fetchImpl?: Fetch; }

const SYSTEM = [
  "You are a video editor choosing short clips from a talk for a specific goal, audience and platform.",
  "For every candidate, rate 0 to 1 how well it would work as a standalone clip for that goal and audience:",
  "on-topic substance and a clear point score high; greetings, sign-offs, tangents and fragments score low.",
  "Return only JSON: {\"scores\":[{\"id\":string,\"relevance\":number,\"reason\":string}]} with one entry per candidate id",
  "and a reason of at most 25 words. Judge only the text given; do not invent content.",
].join(" ");

/** Re-ranker over any OpenAI-compatible chat completions endpoint (JSON mode). */
export class OpenAiCompatibleReranker implements HighlightReranker {
  private readonly fetchImpl: Fetch;
  private readonly calls: number[] = [];
  constructor(private readonly options: OpenAiCompatibleRerankerOptions) {
    if (!options.endpoint || !options.apiKey || !options.model) throw new Error("Re-ranker endpoint, API key and model are required");
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as Fetch);
  }

  async rerank(input: { profile: TailoringProfile; candidates: RerankCandidate[] }): Promise<RerankResult> {
    // Process-wide budget so a burst of proposals cannot run up provider costs.
    const now = Date.now();
    while (this.calls.length && now - this.calls[0]! > 60_000) this.calls.shift();
    if (this.calls.length >= (this.options.maxPerMinute ?? 30)) throw new Error("re-ranking budget for this minute is used up");
    this.calls.push(now);

    const candidates = input.candidates.slice(0, 15).map((candidate) => ({ id: candidate.id, seconds: Math.round((candidate.endUs - candidate.startUs) / 100_000) / 10, text: candidate.text.slice(0, 600) }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    let response;
    try {
      response = await this.fetchImpl(this.options.endpoint.replace(/\/$/, "") + "/chat/completions", {
        method: "POST", signal: controller.signal,
        headers: { authorization: "Bearer " + this.options.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.options.model, temperature: 0, response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: JSON.stringify({ goal: input.profile.intent.slice(0, 500), audience: input.profile.audience.slice(0, 200), platform: input.profile.channel.slice(0, 80), tone: input.profile.tone?.slice(0, 80), candidates }) },
          ],
        }),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("re-ranker timed out");
      throw error;
    } finally { clearTimeout(timer); }
    if (!response.ok) throw new Error("re-ranker returned status " + response.status);
    return { scores: parseScores(await response.json(), candidates.map((candidate) => candidate.id)), model: this.options.model };
  }
}

/** Validates the provider's answer: every id once, relevance in [0,1], short reasons. Throws otherwise. */
export function parseScores(payload: unknown, ids: string[]): RerankResult["scores"] {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("re-ranker returned no content");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error("re-ranker returned invalid JSON"); }
  const scores = (parsed as { scores?: unknown })?.scores;
  if (!Array.isArray(scores)) throw new Error("re-ranker returned no scores");
  const known = new Set(ids);
  const out = new Map<string, { id: string; relevance: number; reason: string }>();
  for (const entry of scores as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.id !== "string" || !known.has(entry.id) || out.has(entry.id)) continue;
    const relevance = Number(entry.relevance);
    if (!Number.isFinite(relevance) || relevance < 0 || relevance > 1) continue;
    out.set(entry.id, { id: entry.id, relevance, reason: typeof entry.reason === "string" ? entry.reason.replace(/\s+/g, " ").trim().slice(0, 240) : "" });
  }
  if (out.size < Math.ceil(ids.length * 0.8)) throw new Error("re-ranker scored only " + out.size + " of " + ids.length + " candidates");
  return [...out.values()];
}
