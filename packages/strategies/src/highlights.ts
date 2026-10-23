import { mergeSpans, pausesFromWords } from "@videocraft/analysis";
import { buildCues, cueOperations } from "@videocraft/captions";
import { describePreferences, type LearnedPreferences } from "@videocraft/domain";
import type { EditingProposal, EditingStrategy, Evidence, TailoringProfile, TimelineOperation, TimelineSignals, TranscriptSegment, TranscriptWord } from "@videocraft/domain";

export interface HighlightWeights { relevance: number; hook: number; density: number; completeness: number; length: number; delivery: number; }
export type HighlightFeatures = Record<keyof HighlightWeights, number>;

export interface HighlightScore { score: number; features: HighlightFeatures; matchedTerms: string[]; }
export interface HighlightCandidate { startUs: number; endUs: number; text: string; unitIds: string[]; words: TranscriptWord[]; score: number; features: HighlightFeatures; matchedTerms: string[]; }

interface Unit { id: string; startUs: number; endUs: number; text: string; words: TranscriptWord[]; }
interface Policy { minUs: number; maxUs: number; idealUs: number; defaultTargetUs: number; weights: HighlightWeights; pauseCutUs: number; }

const STOPWORDS = new Set("a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its just me more most my no not of on one or our out she so some than that the their them then there these they this those to too up us very was we were what when where which who will with would you your about also any because been being both each few get got him how like make makes made much need needs only other over own same should such take than through under until want wants while why".split(" "));
const GENERIC_GOAL_WORDS = new Set("video videos clip clips short shorts reel reels tiktok instagram youtube linkedin post social platform audience viewers viewer people create creating generate edit editing highlight highlights best moments trailer teaser version cut".split(" "));
const FILLERS = ["um", "uh", "erm", "er", "hmm", "like", "basically", "literally", "actually", "you know", "i mean", "kind of", "sort of"];
const HOOK_PATTERNS: Array<[RegExp, number]> = [
  [/^(did you know|what if|imagine|picture this|here'?s (the|a|why|how)|let me (show|tell)|stop |never |always |don'?t |the (biggest|best|worst|real|one|secret|truth)|most people|nobody|everyone|if you)/i, 0.9],
  [/^(how|why|what|when|who|can|do|does|is|are|should)\b/i, 0.7],
  [/\b(secret|mistake|truth|myth|wrong|surprising|shocking|changed|never|biggest|only|always|free|proven)\b/i, 0.55],
];

const SHORT_FORM: Policy = { minUs: 6_000_000, maxUs: 28_000_000, idealUs: 14_000_000, defaultTargetUs: 30_000_000, pauseCutUs: 450_000, weights: { relevance: 0.3, hook: 0.22, density: 0.14, completeness: 0.1, length: 0.1, delivery: 0.14 } };
const LONG_FORM: Policy = { minUs: 15_000_000, maxUs: 90_000_000, idealUs: 40_000_000, defaultTargetUs: 90_000_000, pauseCutUs: 900_000, weights: { relevance: 0.36, hook: 0.08, density: 0.14, completeness: 0.2, length: 0.08, delivery: 0.14 } };

export function policyFor(profile: TailoringProfile, learned?: LearnedPreferences): Policy {
  const channel = profile.channel.toLowerCase();
  const base = channel === "short-form" || /tiktok|reel|short/.test(channel) ? SHORT_FORM : LONG_FORM;
  const tone = (profile.tone ?? "").toLowerCase();
  const weights = { ...base.weights };
  if (/professional|formal|reflective|sermon/.test(tone)) { weights.hook = weights.hook * 0.5; weights.completeness = weights.completeness + 0.05; weights.delivery = weights.delivery + 0.02; }
  // Tilt toward what this person keeps (bounded multipliers learned from their edits).
  for (const key of Object.keys(weights) as Array<keyof HighlightWeights>) {
    const multiplier = learned?.multipliers[key];
    if (typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier > 0) weights[key] = weights[key] * multiplier;
  }
  return { ...base, weights };
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? []).map((token) => token.replace(/['’]s$/, "")).filter((token) => token.length > 1);
}
export function stem(token: string): string {
  let t = token.replace(/['’-]/g, "");
  for (const suffix of ["ations", "ation", "ingly", "ings", "ing", "edly", "ies", "ied", "ers", "er", "ed", "es", "s"]) {
    if (t.length > suffix.length + 3 && t.endsWith(suffix)) { t = t.slice(0, -suffix.length) + (suffix === "ies" || suffix === "ied" ? "y" : ""); break; }
  }
  return t;
}
function contentTerms(text: string, drop: Set<string> = new Set()): string[] {
  return tokenize(text).filter((token) => !STOPWORDS.has(token) && !drop.has(token)).map(stem);
}

/** Goal terms weighted by how directly the creator stated them. */
export function goalTerms(profile: TailoringProfile): Map<string, number> {
  const terms = new Map<string, number>();
  const add = (text: string, weight: number, drop: Set<string>) => { for (const term of contentTerms(text, drop)) terms.set(term, Math.max(terms.get(term) ?? 0, weight)); };
  add(profile.intent, 1, GENERIC_GOAL_WORDS);
  for (const constraint of profile.constraints) add(constraint, 0.8, GENERIC_GOAL_WORDS);
  add(profile.audience, 0.4, GENERIC_GOAL_WORDS);
  return terms;
}

export function scoreWindow(unitsText: string, words: TranscriptWord[], durationUs: number, pausedUs: number, endsClean: boolean, startsDependent: boolean, goal: Map<string, number>, policy: Policy): HighlightScore {
  const tokens = tokenize(unitsText);
  const content = tokens.filter((token) => !STOPWORDS.has(token)).map(stem);
  const total = Math.max(1, tokens.length);

  // Relevance: how much of the stated goal this window covers, and how focused it is on it.
  // Recognizers sometimes split compounds ("on boarding"); joined neighbours let those still match.
  const joined = tokens.slice(1).map((token, index) => stem((tokens[index] ?? "") + token));
  const searchable = new Set([...content, ...joined]);
  let matchedWeight = 0;
  const matched = new Set<string>();
  const goalWeight = [...goal.values()].reduce((sum, value) => sum + value, 0);
  for (const [term, weight] of goal) if (searchable.has(term)) { matchedWeight += weight; matched.add(term); }
  const coverage = goalWeight > 0 ? Math.min(1, (matchedWeight / goalWeight) * 2.5) : 0.5;
  const focus = goal.size > 0 ? Math.min(1, (content.filter((term) => goal.has(term)).length + joined.filter((term) => goal.has(term)).length) / total * 6) : 0.5;
  const relevance = goal.size > 0 ? 0.65 * coverage + 0.35 * focus : 0.5;

  // Hook: how well the opening lines grab attention.
  const opening = unitsText.trim().split(/(?<=[.!?])\s+/)[0] ?? unitsText;
  let hook = /\d/.test(opening) ? 0.35 : 0.1;
  for (const [pattern, value] of HOOK_PATTERNS) if (pattern.test(opening.trim())) hook = Math.max(hook, value);
  if (/\?\s*$/.test(opening.trim())) hook = Math.max(hook, 0.75);
  if (startsDependent) hook *= 0.6;

  // Density: speaking rate in a healthy range, few fillers, varied vocabulary.
  const seconds = Math.max(0.5, durationUs / 1_000_000);
  const rate = tokens.length / Math.max(0.5, (durationUs - pausedUs) / 1_000_000);
  const rateScore = rate < 1.2 ? rate / 1.2 * 0.6 : rate <= 3.4 ? 1 : Math.max(0.4, 1 - (rate - 3.4) / 3);
  const lower = " " + tokens.join(" ") + " ";
  const fillerCount = FILLERS.reduce((count, filler) => count + (lower.split(" " + filler + " ").length - 1), 0);
  const fillerPenalty = Math.min(0.6, fillerCount / total * 4);
  const diversity = Math.min(1, new Set(content).size / Math.max(1, content.length) * 1.2);
  const density = Math.max(0, (0.5 * rateScore + 0.5 * diversity) - fillerPenalty);

  const completeness = (endsClean ? 1 : 0.5) * (startsDependent ? 0.65 : 1) + (endsClean ? 0 : 0);
  const ratio = durationUs / policy.idealUs;
  const length = ratio <= 1 ? Math.max(0.2, ratio) : Math.max(0.2, 1 - (ratio - 1) * 0.5);
  const delivery = Math.max(0, 1 - pausedUs / (seconds * 1_000_000) * 2.5);

  const features: HighlightFeatures = { relevance: round(relevance), hook: round(hook), density: round(density), completeness: round(Math.min(1, completeness)), length: round(length), delivery: round(delivery) };
  const w = policy.weights;
  const weightSum = Object.values(w).reduce((a, b) => a + b, 0);
  const score = (features.relevance * w.relevance + features.hook * w.hook + features.density * w.density + features.completeness * w.completeness + features.length * w.length + features.delivery * w.delivery) / weightSum;
  return { score: round(score), features, matchedTerms: [...matched].sort() };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function buildUnits(transcript: TranscriptSegment[]): Unit[] {
  const units: Unit[] = [];
  for (const segment of [...transcript].sort((a, b) => a.startUs - b.startUs)) {
    const words = segment.words.length > 0 ? segment.words : synthesizeWords(segment);
    let current: TranscriptWord[] = [];
    const flush = () => {
      const first = current[0]; const last = current[current.length - 1];
      if (first && last) units.push({ id: segment.id + "#" + units.length, startUs: first.startUs, endUs: last.endUs, text: current.map((word) => word.text.trim()).join(" ").replace(/\s+/g, " "), words: current });
      current = [];
    };
    for (const word of words) {
      current.push(word);
      if (/[.!?…]["')\]]*$/.test(word.text.trim())) flush();
    }
    flush();
  }
  return units;
}

function synthesizeWords(segment: TranscriptSegment): TranscriptWord[] {
  const parts = segment.text.trim().split(/\s+/).filter(Boolean);
  const step = (segment.endUs - segment.startUs) / Math.max(1, parts.length);
  return parts.map((text, index) => ({ text, startUs: Math.round(segment.startUs + index * step), endUs: Math.round(segment.startUs + (index + 1) * step) }));
}

function overlapUs(spans: Array<{ startUs: number; endUs: number }>, startUs: number, endUs: number): number {
  let total = 0;
  for (const span of spans) total += Math.max(0, Math.min(span.endUs, endUs) - Math.max(span.startUs, startUs));
  return total;
}

/** Generates and scores candidate highlight windows built from whole sentences. */
export function findCandidates(transcript: TranscriptSegment[], profile: TailoringProfile, signals?: TimelineSignals, range?: { startUs: number; endUs: number }, learned?: LearnedPreferences): HighlightCandidate[] {
  const policy = policyFor(profile, learned);
  const goal = goalTerms(profile);
  const units = buildUnits(transcript).filter((unit) => !range || (unit.startUs >= range.startUs && unit.endUs <= range.endUs));
  const allWords = units.flatMap((unit) => unit.words);
  const pauses = mergeSpans([...(signals?.silences ?? []), ...pausesFromWords(allWords, 350_000)]);
  const candidates: HighlightCandidate[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const first = units[i] as Unit;
    for (let j = i; j < units.length; j += 1) {
      const last = units[j] as Unit;
      const duration = last.endUs - first.startUs;
      if (duration > policy.maxUs) break;
      // A window may not straddle a long gap in the source (it would not be one continuous thought).
      const previous = units[j - 1];
      if (j > i && previous && last.startUs - previous.endUs > 4_000_000) break;
      if (duration < policy.minUs) continue;
      const slice = units.slice(i, j + 1);
      const text = slice.map((unit) => unit.text).join(" ");
      const words = slice.flatMap((unit) => unit.words);
      const endsClean = /[.!?…]["')\]]*$/.test(last.text.trim());
      const startsDependent = /^(and|but|so|because|which|that|then|also|or|however|therefore)\b/i.test(first.text.trim());
      const pausedUs = overlapUs(pauses, first.startUs, last.endUs);
      const result = scoreWindow(text, words, duration, pausedUs, endsClean, startsDependent, goal, policy);
      candidates.push({ startUs: first.startUs, endUs: last.endUs, text, unitIds: slice.map((unit) => unit.id), words, ...result });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.startUs - b.startUs);
}

export interface SelectionOptions { targetUs: number; minScore: number; maxClips: number; }

/** Greedy selection of the best non-overlapping windows up to the target duration. */
export function selectHighlights(candidates: HighlightCandidate[], options: SelectionOptions): HighlightCandidate[] {
  const chosen: HighlightCandidate[] = [];
  let total = 0;
  for (const candidate of candidates) {
    if (chosen.length >= options.maxClips || candidate.score < options.minScore) continue;
    const duration = candidate.endUs - candidate.startUs;
    if (total + duration > options.targetUs * 1.1) continue;
    if (chosen.some((other) => candidate.startUs < other.endUs + 500_000 && candidate.endUs > other.startUs - 500_000)) continue;
    chosen.push(candidate);
    total += duration;
    if (total >= options.targetUs * 0.9) break;
  }
  return chosen.sort((a, b) => a.startUs - b.startUs);
}

export interface TightCutOptions { pauseCutUs: number; leadUs: number; tailUs: number; }

/** Removes internal pauses by splitting a window into its continuous speech runs. */
export function tightCuts(candidate: HighlightCandidate, bounds: { prevEndUs?: number; nextStartUs?: number }, options: TightCutOptions): Array<{ startUs: number; endUs: number }> {
  const words = candidate.words;
  const runs: Array<{ startUs: number; endUs: number }> = [];
  let runStart = (words[0] as TranscriptWord).startUs;
  let runEnd = (words[0] as TranscriptWord).endUs;
  for (const word of words.slice(1)) {
    if (word.startUs - runEnd >= options.pauseCutUs) { runs.push({ startUs: runStart, endUs: runEnd }); runStart = word.startUs; }
    runEnd = Math.max(runEnd, word.endUs);
  }
  runs.push({ startUs: runStart, endUs: runEnd });
  return runs.map((run, index) => {
    const lead = index === 0 ? Math.min(options.leadUs, run.startUs - (bounds.prevEndUs ?? 0) - 20_000) : options.leadUs;
    const tail = index === runs.length - 1 ? Math.min(options.tailUs, (bounds.nextStartUs ?? Number.MAX_SAFE_INTEGER) - run.endUs - 20_000) : options.tailUs;
    return { startUs: Math.max(0, Math.round(run.startUs - Math.max(0, lead))), endUs: Math.round(run.endUs + Math.max(0, tail)) };
  });
}

function excerpt(text: string): string { return text.length > 240 ? text.slice(0, 237) + "…" : text; }

export class HighlightReelStrategy implements EditingStrategy {
  readonly id = "highlight-reel";
  readonly version = "1.0.0";

  async propose(input: Parameters<EditingStrategy["propose"]>[0]): ReturnType<EditingStrategy["propose"]> {
    const { revision, profile, transcript, signals, learned } = input;
    const videoClips = revision.timeline.tracks.find((track) => track.kind === "video")?.clips ?? [];
    const sourceClip = videoClips[0];
    const userEvidence: Evidence[] = [
      { source: "user", reference: "tailoring-profile.intent", excerpt: profile.intent.slice(0, 240) },
      { source: "user", reference: "tailoring-profile.audience", excerpt: profile.audience.slice(0, 240) },
      { source: "user", reference: "tailoring-profile.channel", excerpt: profile.channel.slice(0, 120) },
    ];
    const none = (rationale: string): Awaited<ReturnType<EditingStrategy["propose"]>> => ({ rationale, confidence: 0.3, evidence: userEvidence, operations: [], status: "proposed" });
    if (!sourceClip) return none("No source video clip is available, so no highlights can be selected. Add media first.");
    const assetId = sourceClip.assetId;
    const relevant = transcript.filter((segment) => segment.assetId === assetId);
    if (relevant.length === 0 || relevant.every((segment) => !segment.text.trim())) return none("No transcript exists for the source video. Transcribe it first; highlights are chosen from what is said.");

    const sourceRange = { startUs: Math.min(...videoClips.filter((clip) => clip.assetId === assetId).map((clip) => clip.sourceStartUs)), endUs: Math.max(...videoClips.filter((clip) => clip.assetId === assetId).map((clip) => clip.sourceEndUs)) };
    const policy = policyFor(profile, learned);
    const targetUs = profile.targetDurationUs && profile.targetDurationUs > 0 ? profile.targetDurationUs : policy.defaultTargetUs;
    const sourceDurationUs = sourceRange.endUs - sourceRange.startUs;
    const candidates = findCandidates(relevant, profile, signals, sourceRange, learned);

    // A source that already fits the target needs tightening, not selection.
    const wantsAll = sourceDurationUs <= targetUs * 1.05;
    const selected = wantsAll
      ? candidates.length > 0 ? [wholeSource(relevant, sourceRange, candidates)] : []
      : selectHighlights(candidates, { targetUs, minScore: 0.3, maxClips: Math.max(3, Math.ceil(targetUs / policy.idealUs) + 2) });
    if (selected.length === 0) return none("No segment of the transcript was long and complete enough to stand alone as a highlight for this goal.");

    const allWords = relevant.flatMap((segment) => segment.words);
    const operations: TimelineOperation[] = videoClips.map((clip) => ({ type: "remove-clip", clipId: clip.id, reason: "Replaced by selected highlights" }));
    const kept: Array<{ startUs: number; endUs: number }> = [];
    const evidence: Evidence[] = [...userEvidence];
    selected.forEach((candidate, index) => {
      const earlier = allWords.filter((word) => word.endUs <= candidate.startUs).reduce((max, word) => Math.max(max, word.endUs), 0);
      const later = allWords.filter((word) => word.startUs >= candidate.endUs).reduce((min, word) => Math.min(min, word.startUs), Number.MAX_SAFE_INTEGER);
      const cuts = tightCuts(candidate, { prevEndUs: earlier, nextStartUs: later }, { pauseCutUs: policy.pauseCutUs, leadUs: 150_000, tailUs: 220_000 });
      const removedUs = (candidate.endUs - candidate.startUs) - cuts.reduce((sum, cut) => sum + (cut.endUs - cut.startUs), 0);
      const reason = describe(candidate, index + 1, selected.length, cuts.length > 1 ? removedUs : 0);
      const shotCuts = (signals?.scenes ?? []).map((scene) => scene.startUs).filter((at) => at > 0);
      cuts.forEach((rawCut) => {
        const cut = snapToShotCuts(rawCut, shotCuts, allWords);
        const clampedStart = Math.max(sourceRange.startUs, cut.startUs);
        const clampedEnd = Math.min(sourceRange.endUs, cut.endUs);
        if (clampedEnd <= clampedStart) return;
        operations.push({ type: "insert-clip", assetId, sourceStartUs: clampedStart, sourceEndUs: clampedEnd, reason, score: candidate.score, features: { ...candidate.features } });
        kept.push({ startUs: clampedStart, endUs: clampedEnd });
      });
      evidence.push({ source: "transcript", reference: candidate.unitIds[0]?.split("#")[0] ?? "transcript", excerpt: excerpt(candidate.text), startUs: candidate.startUs, endUs: candidate.endUs });
      evidence.push({ source: "model", reference: "highlight-score:" + (index + 1), excerpt: "score " + candidate.score + " — " + Object.entries(candidate.features).map(([key, value]) => key + " " + value).join(", ") + (candidate.matchedTerms.length ? "; matched goal terms: " + candidate.matchedTerms.join(", ") : ""), startUs: candidate.startUs, endUs: candidate.endUs });
    });

    for (const op of cueOperations(assetId, buildCues(allWords, { ranges: kept }))) operations.push(op);
    const learnedNote = learned ? describePreferences(learned, LABELS) : undefined;
    if (learned && learnedNote) evidence.push({ source: "model", reference: "learned-preferences", excerpt: "From " + learned.samples + " of your past edits: " + learnedNote + ". Multipliers: " + Object.entries(learned.multipliers).map(([key, value]) => key + " ×" + value).join(", ") });

    const keptUs = kept.reduce((sum, range) => sum + (range.endUs - range.startUs), 0);
    const averageScore = selected.reduce((sum, candidate) => sum + candidate.score, 0) / selected.length;
    const coverage = Math.min(1, allWords.length / Math.max(1, sourceDurationUs / 1_000_000 * 1.5));
    return {
      rationale: "Selected " + selected.length + " highlight" + (selected.length === 1 ? "" : "s") + " (" + (keptUs / 1_000_000).toFixed(1) + "s of " + (sourceDurationUs / 1_000_000).toFixed(1) + "s) that best match \"" + profile.intent.slice(0, 120) + "\" for " + profile.audience.slice(0, 80) + " on " + profile.channel + ". Pauses longer than " + (policy.pauseCutUs / 1_000_000).toFixed(2) + "s are cut and captions follow the spoken words. Review each clip's reason and transcript evidence before accepting." + (learnedNote ? " Adjusted to your past edits: " + learnedNote + "." : ""),
      confidence: round(Math.max(0.2, Math.min(0.9, averageScore * (0.6 + 0.4 * coverage)))),
      evidence,
      operations,
      status: "proposed",
    };
  }
}

/**
 * Moves a clip edge onto a nearby shot change so a clip does not open or close on a stray frame of the
 * neighbouring shot. An edge only moves when no spoken word would be clipped or exposed by the move.
 */
export function snapToShotCuts(cut: { startUs: number; endUs: number }, shotCutsUs: number[], words: Array<{ startUs: number; endUs: number }>, maxMoveUs = 350_000): { startUs: number; endUs: number } {
  if (shotCutsUs.length === 0) return cut;
  const nearest = (edge: number) => shotCutsUs.filter((at) => Math.abs(at - edge) <= maxMoveUs).sort((a, b) => Math.abs(a - edge) - Math.abs(b - edge))[0];
  const startsWordIn = (from: number, to: number) => words.some((word) => word.endUs > from && word.startUs < to);
  let { startUs, endUs } = cut;
  const startCut = nearest(startUs);
  // Moving the start between the old and new position must not drop or add any speech.
  if (startCut !== undefined && startCut !== startUs && !startsWordIn(Math.min(startCut, startUs), Math.max(startCut, startUs))) startUs = startCut;
  const endCut = nearest(endUs);
  if (endCut !== undefined && endCut !== endUs && !startsWordIn(Math.min(endCut, endUs), Math.max(endCut, endUs))) endUs = endCut;
  return endUs - startUs >= 300_000 ? { startUs, endUs } : cut;
}

function wholeSource(transcript: TranscriptSegment[], range: { startUs: number; endUs: number }, candidates: HighlightCandidate[]): HighlightCandidate {
  const words = transcript.flatMap((segment) => segment.words.length > 0 ? segment.words : synthesizeWords(segment)).filter((word) => word.startUs >= range.startUs && word.endUs <= range.endUs);
  const best = candidates[0] as HighlightCandidate;
  return { ...best, startUs: words[0]?.startUs ?? range.startUs, endUs: words[words.length - 1]?.endUs ?? range.endUs, words: words.length ? words : best.words, text: words.map((word) => word.text).join(" ") || best.text, unitIds: transcript.map((segment) => segment.id) };
}

function describe(candidate: HighlightCandidate, index: number, total: number, removedUs: number): string {
  const f = candidate.features;
  const strengths = (Object.entries(f) as Array<[keyof HighlightFeatures, number]>).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([key]) => LABELS[key]);
  const weak = (Object.entries(f) as Array<[keyof HighlightFeatures, number]>).sort((a, b) => a[1] - b[1])[0];
  return "Highlight " + index + "/" + total + " (score " + candidate.score + "): strongest on " + strengths.join(" and ") + (weak && weak[1] < 0.5 ? "; weakest on " + LABELS[weak[0]] : "") + (candidate.matchedTerms.length ? "; speaks to " + candidate.matchedTerms.slice(0, 5).join(", ") : "") + (removedUs > 0 ? "; " + (removedUs / 1_000_000).toFixed(1) + "s of pauses removed" : "") + ".";
}
const LABELS: Record<keyof HighlightWeights, string> = { relevance: "relevance to the goal", hook: "opening hook", density: "information density", completeness: "self-contained wording", length: "length for the platform", delivery: "delivery pace" };
