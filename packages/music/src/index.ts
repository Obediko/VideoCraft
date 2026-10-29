/**
 * In-house instrumental music beds for VideoCraft: no model, no external service, no licence questions.
 * A mood sets the key, tempo, progression and arrangement; the bed is built to an exact length with an
 * intro, a groove and an outro, and lifts gently at the video's cut points.
 */

export type Mood = "upbeat" | "calm" | "inspiring" | "serious" | "playful";
export const MOODS: Mood[] = ["upbeat", "calm", "inspiring", "serious", "playful"];

export interface MusicOptions {
  mood: Mood;
  durationS: number;
  /** Cut points in seconds; the bed adds a soft lift into each (at most one per bar). */
  accentsS?: number[];
  seed?: number;
  sampleRate?: number;
}
export interface MusicResult { left: Float32Array; right: Float32Array; sampleRate: number; bpm: number; key: string; mode: "major" | "minor"; chords: string[]; description: string; }

interface Style { bpm: number; mode: "major" | "minor"; progression: number[]; drums: "none" | "soft" | "pulse" | "full" | "bouncy"; arp: "none" | "quarters" | "eighths" | "staccato"; pad: number; bass: "whole" | "quarters" | "eighths" | "bounce"; brightness: number; }
const STYLES: Record<Mood, Style> = {
  upbeat: { bpm: 112, mode: "major", progression: [0, 4, 5, 3], drums: "full", arp: "eighths", pad: 0.22, bass: "eighths", brightness: 0.75 },
  calm: { bpm: 76, mode: "major", progression: [0, 5, 3, 4], drums: "none", arp: "quarters", pad: 0.3, bass: "whole", brightness: 0.4 },
  inspiring: { bpm: 96, mode: "major", progression: [5, 3, 0, 4], drums: "pulse", arp: "eighths", pad: 0.28, bass: "quarters", brightness: 0.6 },
  serious: { bpm: 88, mode: "minor", progression: [0, 5, 2, 6], drums: "soft", arp: "quarters", pad: 0.3, bass: "whole", brightness: 0.35 },
  playful: { bpm: 118, mode: "major", progression: [0, 3, 4, 3], drums: "bouncy", arp: "staccato", pad: 0.14, bass: "bounce", brightness: 0.8 },
};
const KEYS = [{ name: "C", midi: 48 }, { name: "D", midi: 50 }, { name: "E♭", midi: 51 }, { name: "F", midi: 53 }, { name: "G", midi: 55 }, { name: "A", midi: 57 }];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const ROMAN_MAJOR = ["I", "ii", "iii", "IV", "V", "vi", "vii°"];
const ROMAN_MINOR = ["i", "ii°", "III", "iv", "v", "VI", "VII"];

/** Picks a mood from the words of a brief; short-form defaults to upbeat, anything else to calm. */
export function inferMood(text: string, channel = ""): Mood {
  const t = text.toLowerCase();
  if (/\b(calm|relax|gentle|soft|peace|meditat|sleep|soothing|reflect|devotion|worship|prayer)/.test(t)) return "calm";
  if (/\b(serious|professional|formal|corporate|news|investig|warning|sermon|grief|sad|dramatic|documentar)/.test(t)) return "serious";
  if (/\b(inspir|motivat|uplift|hope|journey|story|mission|impact|graduat|achiev|success)/.test(t)) return "inspiring";
  if (/\b(fun|funny|playful|kids|children|comedy|silly|quirky|cute|game)/.test(t)) return "playful";
  if (/\b(energ|hype|exciting|launch|sale|promo|upbeat|fast|dynamic|viral)/.test(t)) return "upbeat";
  return /short|tiktok|reel/.test(channel.toLowerCase()) ? "upbeat" : "calm";
}

function prng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

// One-cycle wavetables: a warm pad (soft saw), a round pluck and a sine.
const TABLE = 2048;
function table(harmonics: (n: number) => number): Float32Array {
  const out = new Float32Array(TABLE + 1);
  for (let i = 0; i <= TABLE; i += 1) { let v = 0; for (let n = 1; n <= 16; n += 1) v += harmonics(n) * Math.sin((2 * Math.PI * n * i) / TABLE); out[i] = v; }
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v)); for (let i = 0; i <= TABLE; i += 1) out[i] = out[i]! / peak;
  return out;
}
const PAD = table((n) => 1 / n / (1 + n * 0.15));
const PLUCK = table((n) => (n % 2 ? 1 / (n * n) : 0.3 / (n * n)));
const SINE = table((n) => (n === 1 ? 1 : 0));
function osc(tab: Float32Array, phase: number): number { const p = (phase - Math.floor(phase)) * TABLE; const i = p | 0; const f = p - i; return tab[i]! + (tab[i + 1]! - tab[i]!) * f; }

export function generateMusic(options: MusicOptions): MusicResult {
  const sr = options.sampleRate ?? 44_100;
  const style = STYLES[options.mood];
  const rand = prng(options.seed ?? 1);
  const key = KEYS[Math.floor(rand() * KEYS.length)]!;
  const scale = style.mode === "major" ? MAJOR : MINOR;
  const roman = style.mode === "major" ? ROMAN_MAJOR : ROMAN_MINOR;
  const duration = Math.max(3, Math.min(600, options.durationS));
  const n = Math.round(duration * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const send = new Float32Array(n); // reverb send (mono)
  const beat = 60 / style.bpm;
  const bar = beat * 4;
  const bars = Math.ceil(duration / bar);
  // Energy per bar: a 2-bar intro without drums, a groove, and a 2-bar outro that thins out.
  const energy = (b: number) => (b < 2 ? 0 : b >= bars - 2 && bars > 5 ? 0.5 : 1);
  const degree = (d: number, octave = 0) => key.midi + scale[((d % 7) + 7) % 7]! + 12 * (Math.floor(d / 7) + octave);
  const chordOf = (b: number) => style.progression[b % style.progression.length]!;

  const addNote = (tab: Float32Array, freq: number, start: number, length: number, amp: number, attack: number, release: number, pan: number, wet: number, detune = 0) => {
    const s0 = Math.max(0, Math.floor(start * sr));
    const s1 = Math.min(n, Math.floor((start + length + release) * sr));
    const gl = amp * Math.cos((pan + 1) * Math.PI / 4);
    const gr = amp * Math.sin((pan + 1) * Math.PI / 4);
    const fl = freq * Math.pow(2, -detune / 1200);
    const fr = freq * Math.pow(2, detune / 1200);
    for (let s = s0; s < s1; s += 1) {
      const t = (s - s0) / sr;
      const env = t < attack ? t / attack : t < length ? 1 : Math.max(0, 1 - (t - length) / release);
      const l = osc(tab, fl * t) * env;
      const r = osc(tab, fr * t) * env;
      L[s] = L[s]! + l * gl;
      R[s] = R[s]! + r * gr;
      send[s] = send[s]! + (l + r) * 0.5 * amp * wet;
    }
  };
  const addPerc = (start: number, kind: "kick" | "hat" | "clap", amp: number) => {
    const s0 = Math.floor(start * sr);
    const len = Math.floor((kind === "kick" ? 0.35 : kind === "hat" ? 0.05 : 0.16) * sr);
    let prev = 0;
    for (let i = 0; i < len && s0 + i < n; i += 1) {
      const t = i / sr;
      let v: number;
      if (kind === "kick") { const f = 45 + 80 * Math.exp(-t * 30); v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9); }
      else if (kind === "hat") { const w = rand() * 2 - 1; v = (w - prev) * 0.5 * Math.exp(-t * 70); prev = w; }
      else { v = ((rand() * 2 - 1) * 0.7 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-t * 22); }
      const p = kind === "hat" ? 0.25 : 0;
      L[s0 + i] = L[s0 + i]! + v * amp * (1 - p);
      R[s0 + i] = R[s0 + i]! + v * amp * (1 + p);
      if (kind === "clap") send[s0 + i] = send[s0 + i]! + v * amp * 0.25;
    }
  };

  const chords: string[] = [];
  for (let b = 0; b < bars; b += 1) {
    const t0 = b * bar;
    const root = chordOf(b);
    if (b < style.progression.length) chords.push(roman[((root % 7) + 7) % 7]!);
    const e = energy(b);
    // Pad: the triad plus the ninth for colour, held across the bar with soft overlaps.
    for (const [i, d] of [root, root + 2, root + 4, root + 8].entries()) addNote(PAD, hz(degree(d, 1)), t0, bar, style.pad * (i === 3 ? 0.4 : 1) * (0.7 + 0.3 * e), bar * 0.25, bar * 0.35, (i - 1.5) * 0.35, 0.6, 6);
    // Bass.
    const bassNote = hz(degree(root, -1));
    const bassHits = style.bass === "whole" ? [0] : style.bass === "quarters" ? [0, 1, 2, 3] : style.bass === "eighths" ? [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] : [0, 0.75, 1.5, 2, 3, 3.5];
    for (const h of bassHits) addNote(SINE, bassNote * (style.bass === "bounce" && h === 1.5 ? 1.5 : 1), t0 + h * beat, style.bass === "whole" ? bar * 0.9 : beat * 0.42, 0.26 * (b < 1 ? 0.6 : 1), 0.01, 0.08, 0, 0);
    // Arpeggio from the chord tones, an octave up.
    if (style.arp !== "none" && b >= 1) {
      const step = style.arp === "quarters" ? 1 : 0.5;
      const tones = [root, root + 2, root + 4, root + 7, root + 4, root + 2];
      for (let k = 0, h = 0; h < 4; h += step, k += 1) addNote(PLUCK, hz(degree(tones[k % tones.length]!, 2)), t0 + h * beat, style.arp === "staccato" ? beat * 0.12 : beat * 0.3, 0.11 * style.brightness * (0.6 + 0.4 * e), 0.004, beat * 0.5, (k % 2 ? 0.4 : -0.4), 0.5);
    }
    // Drums.
    if (e > 0 && style.drums !== "none") {
      for (let q = 0; q < 4; q += 1) {
        const at = t0 + q * beat;
        if (style.drums === "full" || style.drums === "bouncy" || (style.drums === "pulse" && q % 2 === 0) || (style.drums === "soft" && q === 0)) addPerc(at, "kick", (style.drums === "soft" ? 0.35 : 0.55) * e);
        if ((style.drums === "full" || style.drums === "bouncy") && (q === 1 || q === 3)) addPerc(at, "clap", 0.22 * e);
        if (style.drums !== "soft") { addPerc(at + beat * 0.5, "hat", 0.16 * e); if (style.drums === "full" || style.drums === "bouncy") addPerc(at, "hat", 0.08 * e); }
      }
    }
  }

  // A soft lift into each cut: a filtered-noise riser over half a beat, then a low hit on the cut.
  let lastAccentBar = -1;
  for (const at of [...(options.accentsS ?? [])].sort((a, b) => a - b)) {
    const b = Math.floor(at / bar);
    if (at < 1 || at > duration - 1 || b === lastAccentBar) continue;
    lastAccentBar = b;
    const len = Math.floor(Math.max(0.35, beat * 0.75) * sr);
    const s0 = Math.floor(at * sr) - len;
    // Riser: noise whose brightness and level climb into the cut (quadratic curve), then a low hit and a short wash.
    let lp = 0; let prev = 0;
    for (let i = 0; i < len && s0 + i < n; i += 1) {
      if (s0 + i < 0) continue;
      const k = i / len;
      const w = rand() * 2 - 1;
      lp += (0.05 + 0.4 * k) * (w - lp);
      const bright = lp - prev * 0.6; prev = lp;
      const v = bright * k * k * 0.9;
      L[s0 + i] = L[s0 + i]! + v; R[s0 + i] = R[s0 + i]! + v; send[s0 + i] = send[s0 + i]! + v * 0.6;
    }
    addPerc(at, "kick", 0.6);
    addPerc(at, "clap", 0.18);
  }

  // Reverb: four combs and two allpasses (Schroeder), slightly different per side for width.
  const reverb = (offset: number) => {
    const out = new Float32Array(n);
    for (const [ms, fb] of [[29.7, 0.77], [37.1, 0.75], [41.1, 0.73], [43.7, 0.71]] as const) {
      const d = Math.floor(((ms + offset) / 1000) * sr); const buf = new Float32Array(d); let idx = 0; let damp = 0;
      for (let s = 0; s < n; s += 1) { const y = buf[idx]!; damp = y * 0.55 + damp * 0.45; buf[idx] = send[s]! + damp * fb; idx = (idx + 1) % d; out[s] = out[s]! + y * 0.25; }
    }
    for (const ms of [5, 1.7]) {
      const d = Math.floor(((ms + offset * 0.1) / 1000) * sr); const buf = new Float32Array(d); let idx = 0;
      for (let s = 0; s < n; s += 1) { const x = out[s]!; const y = buf[idx]!; buf[idx] = x + y * 0.5; out[s] = y - x * 0.5; idx = (idx + 1) % d; }
    }
    return out;
  };
  const wetL = reverb(0);
  const wetR = reverb(2.3);

  // Master: gentle low-pass for warmth, then a light soft clip whose drive does not depend on how loud
  // the mix happens to be (so dense moods are not squashed), -1 dBFS peak, fade in and out.
  let raw = 0;
  let pl = 0; let pr = 0;
  const cutoff = 1 - Math.exp((-2 * Math.PI * (4000 + 6000 * style.brightness)) / sr);
  for (let s = 0; s < n; s += 1) {
    pl += cutoff * (L[s]! + wetL[s]! * 0.9 - pl);
    pr += cutoff * (R[s]! + wetR[s]! * 0.9 - pr);
    L[s] = pl; R[s] = pr;
    raw = Math.max(raw, Math.abs(pl), Math.abs(pr));
  }
  const drive = 1.4;
  let peak = 0;
  for (let s = 0; s < n; s += 1) {
    L[s] = Math.tanh((drive * L[s]!) / (raw || 1));
    R[s] = Math.tanh((drive * R[s]!) / (raw || 1));
    peak = Math.max(peak, Math.abs(L[s]!), Math.abs(R[s]!));
  }
  const gain = peak > 0 ? 0.891 / peak : 1;
  const fadeIn = Math.floor(0.3 * sr);
  const fadeOut = Math.floor(Math.min(2, duration / 4) * sr);
  for (let s = 0; s < n; s += 1) {
    const f = Math.min(1, s / fadeIn, (n - s) / fadeOut);
    L[s] = L[s]! * gain * f;
    R[s] = R[s]! * gain * f;
  }
  const keyName = key.name + " " + style.mode;
  return { left: L, right: R, sampleRate: sr, bpm: style.bpm, key: keyName, mode: style.mode, chords, description: options.mood[0]!.toUpperCase() + options.mood.slice(1) + " · " + keyName + " · " + style.bpm + " BPM · " + chords.join("–") };
}

/** 16-bit PCM stereo WAV. */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Buffer {
  const frames = left.length;
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + frames * 4, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i]!)) * 32767), 44 + i * 4);
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i]!)) * 32767), 46 + i * 4);
  }
  return buffer;
}

export type SoundEffectKind = "whoosh" | "pop" | "hit" | "riser";

/** Short synthesised sound effects for cuts, graphics and reveals (48 kHz stereo, peak about -3 dBFS). */
export function generateSoundEffect(kind: SoundEffectKind, sampleRate = 48_000, seed = 7): { left: Float32Array; right: Float32Array; sampleRate: number } {
  const seconds = { whoosh: 0.7, pop: 0.25, hit: 1.2, riser: 1.8 }[kind];
  const n = Math.round(seconds * sampleRate);
  const left = new Float32Array(n); const right = new Float32Array(n);
  const rand = prng(seed);
  // A resonant band-pass (state-variable filter) gives noise a pitch that can sweep.
  let low = 0, band = 0, low2 = 0, band2 = 0, phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate; const x = t / seconds; const noise = rand() * 2 - 1;
    let sample = 0; let pan = 0.5;
    if (kind === "whoosh") {
      const env = x < 0.6 ? Math.pow(x / 0.6, 2) : Math.pow(1 - (x - 0.6) / 0.4, 1.5);
      const centre = 300 + 2600 * Math.sin(Math.PI * Math.min(1, x * 1.1));
      const f = 2 * Math.sin((Math.PI * centre) / sampleRate); const q = 0.35;
      low += f * band; const high = noise - low - q * band; band += f * high;
      sample = band * env * 1.6; pan = 0.15 + 0.7 * x;
    } else if (kind === "pop") {
      const freq = 300 + 700 * Math.exp(-t * 40); phase += freq / sampleRate;
      sample = Math.sin(2 * Math.PI * phase) * Math.exp(-t * 22) + noise * Math.exp(-t * 400) * 0.4;
    } else if (kind === "hit") {
      const freq = 45 + 70 * Math.exp(-t * 18); phase += freq / sampleRate;
      const f = 2 * Math.sin((Math.PI * 1800) / sampleRate);
      low2 += f * band2; const high = noise - low2 - 0.8 * band2; band2 += f * high;
      sample = Math.tanh(1.6 * Math.sin(2 * Math.PI * phase)) * Math.exp(-t * 3.2) + low2 * Math.exp(-t * 14) * 0.6;
    } else {
      const freq = 180 * Math.pow(7, x); phase += freq / sampleRate;
      const centre = 400 + 5000 * x * x; const f = 2 * Math.sin((Math.PI * Math.min(centre, sampleRate / 6)) / sampleRate);
      low += f * band; const high = noise - low - 0.3 * band; band += f * high;
      const saw = 2 * (phase - Math.floor(phase)) - 1;
      sample = (band * 0.9 + saw * 0.25) * Math.pow(x, 1.8) * (x > 0.97 ? (1 - x) / 0.03 : 1);
    }
    left[i] = sample * Math.cos((pan * Math.PI) / 2) * Math.SQRT2;
    right[i] = sample * Math.sin((pan * Math.PI) / 2) * Math.SQRT2;
  }
  let peak = 0; for (let i = 0; i < n; i += 1) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  const gain = peak > 0 ? 0.7 / peak : 0;
  // 2 ms fades so nothing clicks.
  const fade = Math.min(n / 2, Math.round(sampleRate * 0.002));
  for (let i = 0; i < n; i += 1) { const e = Math.min(1, i / fade, (n - 1 - i) / fade); left[i] = left[i]! * gain * e; right[i] = right[i]! * gain * e; }
  return { left, right, sampleRate };
}
