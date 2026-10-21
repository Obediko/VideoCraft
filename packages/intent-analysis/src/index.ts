import type { Evidence, IntentAnalysisPort, TailoringProfile, TranscriptSegment } from "@videocraft/domain";

export interface IntentFetchResponse { ok: boolean; status?: number; json(): Promise<unknown>; }
export type IntentFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<IntentFetchResponse>;
export interface OpenAiCompatibleIntentOptions { endpoint: string; apiKey: string; model: string; fetchImpl?: IntentFetch; }

export class RuleBasedIntentAnalyzer implements IntentAnalysisPort {
  async analyze(input: { prompt: string; transcript?: TranscriptSegment[] }): Promise<{ profile: TailoringProfile; evidence: Evidence[]; provider: string; providerVersion: string }> {
    const prompt = validatePrompt(input.prompt);
    const lower = prompt.toLowerCase();
    const channel = lower.includes("tiktok") || lower.includes("reel") || lower.includes("short") ? "short-form" : lower.includes("youtube") ? "youtube" : "web";
    const tone = lower.includes("professional") || lower.includes("formal") ? "professional" : lower.includes("fun") || lower.includes("playful") ? "playful" : "clear";
    const targetDurationUs = lower.includes("30") || channel === "short-form" ? 30_000_000 : undefined;
    const transcriptEvidence = input.transcript?.find((segment) => segment.text.trim().length > 0);
    const profile: TailoringProfile = { intent: prompt, audience: inferAudience(lower), channel, ...(targetDurationUs === undefined ? {} : { targetDurationUs }), tone, constraints: [] };
    const evidence: Evidence[] = [{ source: "user", reference: "intent.prompt", excerpt: prompt.slice(0, 240) }];
    if (transcriptEvidence) evidence.push({ source: "transcript", reference: transcriptEvidence.id, excerpt: transcriptEvidence.text.slice(0, 240) });
    return { profile, evidence, provider: "rule-based-intent", providerVersion: "1.0.0" };
  }
}

export class OpenAiCompatibleIntentAnalyzer implements IntentAnalysisPort {
  private readonly fetchImpl: IntentFetch;
  constructor(private readonly options: OpenAiCompatibleIntentOptions) {
    if (!options.endpoint || !options.apiKey || !options.model) throw new Error("Intent provider endpoint, API key, and model are required");
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as IntentFetch);
  }
  async analyze(input: { prompt: string; transcript?: TranscriptSegment[] }): Promise<{ profile: TailoringProfile; evidence: Evidence[]; provider: string; providerVersion?: string }> {
    const prompt = validatePrompt(input.prompt);
    const response = await this.fetchImpl(this.options.endpoint.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + this.options.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return only JSON with profile {intent,audience,channel,targetDurationUs?,tone?,constraints[]} and evidence [{source,reference,excerpt?}]. Do not claim model training or certainty." },
          { role: "user", content: JSON.stringify({ prompt, transcript: (input.transcript ?? []).slice(0, 100).map((segment) => ({ id: segment.id, text: segment.text, startUs: segment.startUs, endUs: segment.endUs })) }) },
        ],
      }),
    });
    if (!response.ok) throw new Error("Intent provider request failed with status " + (response.status ?? "unknown"));
    const payload = await response.json();
    const content = extractContent(payload);
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new Error("Intent provider returned invalid JSON"); }
    if (!isObject(parsed) || !isProfile(parsed.profile) || !Array.isArray(parsed.evidence) || !parsed.evidence.every(isEvidence)) throw new Error("Intent provider returned an invalid structured response");
    return { profile: parsed.profile, evidence: parsed.evidence, provider: "openai-compatible", providerVersion: this.options.model };
  }
}

function validatePrompt(prompt: string): string {
  const value = prompt.trim();
  if (value.length < 3 || value.length > 2_000) throw new Error("Intent prompt must contain between 3 and 2,000 characters");
  return value;
}
function extractContent(value: unknown): string {
  if (!isObject(value) || !Array.isArray(value.choices) || !isObject(value.choices[0]) || !isObject(value.choices[0].message) || typeof value.choices[0].message.content !== "string") throw new Error("Intent provider response is missing message content");
  return value.choices[0].message.content;
}
function isProfile(value: unknown): value is TailoringProfile {
  return isObject(value) && typeof value.intent === "string" && typeof value.audience === "string" && typeof value.channel === "string" && Array.isArray(value.constraints) && value.constraints.every((entry) => typeof entry === "string") && (value.targetDurationUs === undefined || typeof value.targetDurationUs === "number") && (value.tone === undefined || typeof value.tone === "string");
}
function isEvidence(value: unknown): value is Evidence {
  return isObject(value) && (value.source === "user" || value.source === "transcript" || value.source === "asset-metadata" || value.source === "model") && typeof value.reference === "string" && (value.excerpt === undefined || typeof value.excerpt === "string");
}
function inferAudience(prompt: string): string {
  if (prompt.includes("developer") || prompt.includes("engineer")) return "Developers and technical practitioners";
  if (prompt.includes("beginner") || prompt.includes("new")) return "People new to the topic";
  if (prompt.includes("customer") || prompt.includes("buyer")) return "Prospective customers";
  return "General audience";
}
function isObject(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
