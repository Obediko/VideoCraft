import type { Evidence, IntentAnalysisPort, TailoringProfile, TranscriptSegment } from "@videocraft/domain";

export class RuleBasedIntentAnalyzer implements IntentAnalysisPort {
  async analyze(input: { prompt: string; transcript?: TranscriptSegment[] }): Promise<{ profile: TailoringProfile; evidence: Evidence[]; provider: string; providerVersion: string }> {
    const prompt = input.prompt.trim();
    if (prompt.length < 3 || prompt.length > 2_000) throw new Error("Intent prompt must contain between 3 and 2,000 characters");
    const lower = prompt.toLowerCase();
    const channel = lower.includes("tiktok") || lower.includes("reel") || lower.includes("short") ? "short-form" : lower.includes("youtube") ? "youtube" : "web";
    const tone = lower.includes("professional") || lower.includes("formal") ? "professional" : lower.includes("fun") || lower.includes("playful") ? "playful" : "clear";
    const targetDurationUs = lower.includes("30") || channel === "short-form" ? 30_000_000 : undefined;
    const transcriptEvidence = input.transcript?.find((segment) => segment.text.trim().length > 0);
    const profile: TailoringProfile = {
      intent: prompt, audience: inferAudience(lower), channel,
      ...(targetDurationUs === undefined ? {} : { targetDurationUs }),
      tone, constraints: [],
    };
    const evidence: Evidence[] = [{ source: "user", reference: "intent.prompt", excerpt: prompt.slice(0, 240) }];
    if (transcriptEvidence) evidence.push({ source: "transcript", reference: transcriptEvidence.id, excerpt: transcriptEvidence.text.slice(0, 240) });
    return { profile, evidence, provider: "rule-based-intent", providerVersion: "1.0.0" };
  }
}
function inferAudience(prompt: string): string {
  if (prompt.includes("developer") || prompt.includes("engineer")) return "Developers and technical practitioners";
  if (prompt.includes("beginner") || prompt.includes("new")) return "People new to the topic";
  if (prompt.includes("customer") || prompt.includes("buyer")) return "Prospective customers";
  return "General audience";
}
