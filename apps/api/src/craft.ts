/**
 * How working directors, documentary editors and scriptwriters approach a short video, written down for the
 * storyboard writer. The model cannot take a course, but it can follow the craft spelled out plainly, and the
 * output is checked afterwards for the stock phrases that make writing sound machine-made.
 */
export const DIRECTOR_CRAFT = `CRAFT (follow it, never mention it):
Story
- One video, one idea, one viewer, one feeling. Decide who is watching and what they should do or feel at the end.
- Open on a concrete moment or a question in the first two seconds: a person doing something, not a slogan or a logo.
- Shape: a situation, a small change, what it leads to. Specific people doing specific, ordinary things beat big statements.
- Show, do not tell. The pictures carry the action; narration adds only what pictures cannot (a thought, a fact from the brief, a feeling). Never describe in words what is on screen.
- Use real details from the brief (names, places, numbers). Never invent facts, statistics, quotes or results.
Scenes (each must be findable in a stock library or filmable on a phone)
- One scene = one shot = one action: who, doing what, where. Plain present tense, one or two short sentences, e.g. "A girl does homework at a plastic table in a courtyard; an older woman leans in and points at the page."
- Vary shot size from scene to scene: wide to show the place, medium for the action, close for hands and faces at the emotional beat.
- Keep shots short in short-form (2-4 s); give the emotional beat a little longer.
- No camera or lighting jargon, no adjective piles ("cinematic", "golden", "soft warm light", "beautiful", "authentic", "dignified"), no instructions about transitions or music in the scene.
- People look like real people in real places; avoid staged, glossy, stock-cliche set-ups (handshakes in front of laptops, people pointing at screens, light bulbs, globes).
Narration (written for the ear)
- Talk like one person telling a friend: short sentences, everyday words, contractions, one idea per sentence. About 2-2.5 words per second of video.
- Be concrete and modest. No hype, no sermons, no rhetorical triplets, no "Imagine a world...", no "It's not just X, it's Y", no questions you then answer yourself.
- Never use these words or phrases: journey, tapestry, testament, unlock, unleash, empower, elevate, vibrant, seamless, transformative, embark, beacon, resonate, foster, navigate, landscape, delve, harness, realm, ever-evolving, game-changer, in today's world, in a world where, more than just, at the heart of, the power of, not only... but also, together we can, make a difference, change lives.
- End on one clear, human line (the call to action if the brief has one), not a slogan.
On-screen text: a few plain words that add information the voice does not say; often none.`;

const ARTIFICIAL = ["journey", "tapestry", "testament", "unlock", "unleash", "empower", "elevate", "vibrant", "seamless", "transformative", "embark", "beacon", "resonate", "foster", "navigate", "landscape", "delve", "harness", "realm", "ever-evolving", "game-changer", "in today's world", "in a world where", "more than just", "at the heart of", "the power of", "imagine a world", "together we can", "make a difference", "change lives", "cinematic", "golden hour", "bathed in"];

/** Stock phrases in a script or scene list that make it read as machine-written (empty when clean). */
export function artificialPhrases(text: string): string[] {
  const t = " " + text.toLowerCase().replace(/[’]/g, "'") + " ";
  const found = ARTIFICIAL.filter((phrase) => new RegExp("[^a-z]" + phrase.replace(/[-']/g, "[-' ]?") + "(s|ed|ing|es)?[^a-z]").test(t));
  if (/it'?s not just [^.]{1,40}, it'?s/.test(t)) found.push("it's not just X, it's Y");
  return [...new Set(found)];
}
