export function scriptQualityIssues(script: string, brief: string, preferences: ScriptPreferences): string[] {
  const lower = script.toLowerCase();
  const issues: string[] = [];

  const banned = [...GENERIC_PHRASES, ...preferences.avoidPhrases.map(x => x.toLowerCase())];
  const found = banned.find(x => x && lower.includes(x));
  if (found) issues.push(`generic phrase: ${found}`);

  const words = script.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) issues.push("script is empty");

  // Keep the guardrail, but do not hard-reject a concise human script that is rich,
  // specific and naturally spoken. A short script should only trigger a rewrite if it
  // is effectively blank or unformed rather than merely brief.
  const seconds = Number(brief.match(/(\d+)\s*(?:second|sec)/i)?.[1] ?? 30);
  const minimumWords = Math.max(6, Math.min(12, Math.round(seconds / 4)));
  if (words.length < minimumWords && !/[.!?]/.test(script)) {
    issues.push("script is too thin for the requested story");
  }

  const repeated = /(very|really|truly|amazing|incredible)\b(?:\W+\w+){0,2}\W+\1\b/i;
  if (repeated.test(script)) issues.push("repetitive intensifiers");

  return issues;
}
