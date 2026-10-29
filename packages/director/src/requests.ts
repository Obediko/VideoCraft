/**
 * The built-in director's understanding of requests in plain words, for everything the editor can add or change:
 * text on screen, captions, cutaways (your media or free stock), voice-overs, music, sound effects, loudness,
 * looks, backgrounds, zooms, transitions, the progress bar, colours, format and taking any of these out again.
 * It returns raw suggestions in the same shape the AI returns, so they go through the same validation.
 */
export interface RequestContext {
  /** Where the creator is in the source (seconds), for "here" / "at this point". */
  playheadS?: number;
  /** The kept pieces in source seconds, in play order. */
  pieces: Array<{ startS: number; endS: number }>;
  /** Project photos and clips by name, for "use my photo of the office". */
  assets: Array<{ id: string; kind: "image" | "video"; name: string }>;
}

const COLOURS: Record<string, string> = {
  red: "#E5484D", green: "#46A758", blue: "#3E63DD", yellow: "#F5D90A", orange: "#F76B15", purple: "#8E4EC6", pink: "#D6409F",
  white: "#FFFFFF", black: "#111111", teal: "#12A594", gold: "#D4A017", grey: "#8B8D98", gray: "#8B8D98", navy: "#1E3A8A", sage: "#A8C49A",
};

export function ruleRequests(instruction: string, ctx: RequestContext): Array<Record<string, unknown>> {
  const original = instruction.trim();
  const t = original.toLowerCase();
  const out: Array<Record<string, unknown>> = [];
  const quoted = /["“”«»]([^"“”«»]{1,300})["“”«»]/.exec(original)?.[1]?.trim()
    ?? /['‘’]([^'‘’]{2,300})['‘’]/.exec(original)?.[1]?.trim();
  const said = quoted ?? /\b(?:saying|that says|which says|reading|with the words?|with the text|:)\s+(.{2,200}?)\s*(?:$|\b(?:at|on|in|for|near)\s+the\s+(?:start|beginning|end|top|bottom)\b)/i.exec(original)?.[1]?.trim();
  const first = ctx.pieces[0]; const last = ctx.pieces[ctx.pieces.length - 1];
  const inside = (s: number) => ctx.pieces.some((p) => s >= p.startS && s < p.endS);
  // Where to put it: "at the start", "at the end", "here" (the playhead), else the playhead or the start.
  const at = (length = 3): number => {
    if (/\b(start|beginning|opening|intro|first)\b/.test(t) && first) return first.startS + 0.2;
    if (/\b(end|ending|outro|last|finish)\b/.test(t) && last) return Math.max(last.startS, last.endS - length - 0.2);
    if (ctx.playheadS !== undefined && inside(ctx.playheadS)) return ctx.playheadS;
    return first ? first.startS + 0.2 : 0;
  };
  const position = /\btop\b/.test(t) ? "top" : /\bbottom\b/.test(t) ? "bottom" : "";
  const remove = /\b(remove|delete|take (?:out|off|away)|get rid of|drop|no more|without|turn off|switch off|hide|clear|don'?t want|do not want|lose the)\b/.test(t);
  const add = !remove && /\b(add|put|insert|place|show|include|give (?:me|it)|use|want|need|with|bring in|turn on|switch on|make (?:a|some))\b/.test(t);
  const push = (s: Record<string, unknown>) => { out.push({ reason: "As you asked.", ...s }); };

  // Taking things out.
  if (remove) {
    const targets: Array<[RegExp, string, string]> = [
      [/\b(music|song|soundtrack|backing track|background (?:music|track|sound))\b/, "music", "Remove the music"],
      [/\b(sound effects?|sfx|whoosh(?:es)?|pops?|swoosh(?:es)?)\b/, "sfx", "Remove the sound effects"],
      [/\bprogress bar\b/, "progress", "Remove the progress bar"],
      [/\b(titles?|headings?|callouts?|lower.?thirds?|name (?:tag|caption|card)s?|on-?screen text|text on screen|graphics|text boxes)\b/, "graphics", "Remove the text on screen"],
      [/\b(cutaways?|b-?roll|stock|gifs?|photos?|pictures?|images?|overlays?)\b/, "cutaways", "Remove the cutaways"],
      [/\b(voice-?overs?|narrations?)\b/, "voiceovers", "Remove the voice-overs"],
      [/\b(captions?|subtitles?)\b/, "captions", "Remove the captions"],
      [/\b(zooms?|punch[- ]?ins?|push[- ]?ins?)\b/, "zooms", "Remove the zooms"],
      [/\b(transitions?|fades?|dips?|flash(?:es)?)\b/, "transitions", "Remove the transitions"],
      [/\b(look|filter|grade|colou?r grade|black and white|b&w)\b/, "look", "Back to natural colour"],
      [/\b(background (?:change|blur|effect|replacement)|blur(?:red)? background|fake background|virtual background)\b/, "background", "Back to the original background"],
    ];
    for (const [pattern, target, title] of targets) if (pattern.test(t)) push({ id: "remove-" + target, kind: "remove", target, title });
  }

  // Text on screen.
  if (add && /\b(lower.?third|name (?:tag|caption|card|title)|my name)\b/.test(t)) {
    const nameMatch = /\bname(?: is|:)?\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,3})/u.exec(original);
    const [name, role] = (quoted ?? nameMatch?.[1] ?? "").split(/\s*[,–—|-]\s+|\s*,\s*/);
    if (name) push({ id: "lower-third", kind: "lower-third", title: "Name caption: " + name, text: name, ...(role ? { subtitle: role } : {}), atS: at(4), durationS: 4 });
    else push({ id: "advice-name", kind: "advice", title: "Which name?", reason: "Put the name in quotes, e.g. add a name caption \"Obed Apochi, Founder\"." });
  } else if (add && /\b(title|heading|headline|title card)\b/.test(t)) {
    if (said) push({ id: "title", kind: "title", title: "Title: " + said.slice(0, 40), text: said.slice(0, 120), atS: at(3), durationS: 3, ...(position ? { position } : {}) });
    else push({ id: "advice-title", kind: "advice", title: "What should the title say?", reason: "Put the words in quotes, e.g. add a title \"3 tips for your first job\"." });
  } else if (add && /\b(callout|text box|pop-?up text|label|sticker text|on-?screen text|text on screen)\b/.test(t)) {
    if (said) push({ id: "callout", kind: "callout", title: "Callout: " + said.slice(0, 40), text: said.slice(0, 120), atS: at(2.5), durationS: 2.5, ...(position ? { position } : {}) });
    else push({ id: "advice-callout", kind: "advice", title: "What should it say?", reason: "Put the words in quotes, e.g. add a callout \"Free for students\"." });
  }

  // Captions, progress bar, sound effects.
  if (add && /\b(captions?|subtitles?)\b/.test(t) && !/\b(name|caption) (caption|box|card|tag)\b|\bcaption (box|card)\b/.test(t)) push({ id: "captions", kind: "captions", title: "Captions for everything you say" });
  if (add && /\bprogress bar\b/.test(t)) push({ id: "progress", kind: "progress", title: "Progress bar across the top" });
  if (add && /\b(sound effects?|sfx|whoosh(?:es)?|swoosh(?:es)?)\b/.test(t) && !/\b(loud|quiet|volume|softer|lower)\b/.test(t)) push({ id: "sfx", kind: "sfx", title: "Subtle sound effects", reason: "A soft whoosh at jumps and a pop when text appears." });

  // Accent colour.
  const hex = /#[0-9a-f]{6}\b/i.exec(original)?.[0];
  const named = Object.keys(COLOURS).find((c) => new RegExp("\\b" + c + "\\b").test(t));
  if ((hex || named) && /\b(colou?r|accent|brand|titles?|text|progress bar|callouts?|make (?:it|them))\b/.test(t) && !/\bbackground\b/.test(t) && !/\b(black and white|b&w)\b/.test(t)) {
    const color = (hex ?? COLOURS[named!]!).toUpperCase();
    push({ id: "color", kind: "color", title: "Accent colour " + (named ?? color), color });
  }

  // Cutaways: your own media by name, or free stock.
  const cutawayWord = /\b(cutaway|b-?roll|stock|footage|clip|video|photo|picture|image|gif|meme)\b/;
  const mode = /\bbehind (?:me|my|him|her|them|the (?:speaker|person))\b/.test(t) ? "behind" : /\b(corner|inset|small|picture in picture|pip)\b/.test(t) ? "pip" : "full";
  if (add && cutawayWord.test(t)) {
    const own = ctx.assets.find((a) => { const name = a.name.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, " ").trim(); return name.length >= 3 && t.includes(name); });
    const subject = /\b(?:of|showing|with|about|featuring|for)\s+(?:a |an |the |some )?([a-z0-9][a-z0-9 '-]{1,60}?)(?=\s+(?:behind|in the corner|as a|at the|here|now|on screen|please)\b|[.,!?]|$)/.exec(t)?.[1]?.trim();
    if (own) push({ id: "broll-own", kind: "broll", title: "Cutaway: " + own.name, assetId: own.id, atS: at(3), durationS: 3, mode });
    else if (subject && !/\b(me|myself|my face)\b/.test(subject)) {
      const assetKind = /\b(gif|meme)\b/.test(t) ? "gif" : /\b(photo|picture|image)\b/.test(t) ? "photo" : "video";
      push({ id: "stock", kind: "stock", title: "Free stock " + (assetKind === "gif" ? "GIF" : assetKind) + ": " + subject, reason: "The best match from the free libraries, placed " + (mode === "behind" ? "behind you" : mode === "pip" ? "in the corner" : "full screen") + ".", query: subject, assetKind, atS: at(3), durationS: assetKind === "gif" ? 2 : 3, mode });
    }
  }

  // Voice-over from typed words.
  if (/\b(voice-?over|narrat(?:e|ion|or)|read (?:out|this)|say (?:this|it) for me)\b/.test(t) && !remove && !/\b(loud|quiet|volume|softer|lower)\b/.test(t)) {
    if (quoted) push({ id: "voiceover", kind: "voiceover", title: "Voice-over: " + quoted.slice(0, 40), text: quoted.slice(0, 1500), atS: at(Math.max(2, quoted.split(/\s+/).length / 2.6)) });
    else push({ id: "advice-voiceover", kind: "advice", title: "What should the voice-over say?", reason: "Put the words in quotes, e.g. add a voice-over \"Welcome to the course\". To use your own voice, record it in Audio → Voice-over." });
  }
  return out;
}
