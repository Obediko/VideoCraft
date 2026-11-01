export function scriptQualityIssues(script: string, brief: string, preferences: ScriptPreferences): string[] {
  const lower = script.toLowerCase();
  const issues: string[] = [];

  const banned = [...GENERIC_PHRASES, ...preferences.avoidPhrases.map(x => x.toLowerCase())];
  const found = banned.find(x => x && lower.includes(x));
  if (found) issues.push(`generic phrase: ${found}`);

  const words = script.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) issues.push("script is empty");

  // A brief, concrete script can still be strong and human. Do not hard-fail on a
  // short runtime budget; a good director values clarity and specificity over filler.
  const repeated = /(very|really|truly|amazing|incredible)\b(?:\W+\w+){0,2}\W+\1\b/i;
  if (repeated.test(script)) issues.push("repetitive intensifiers");

  return issues;
}
