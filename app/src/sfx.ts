// The game's own sounds, made in code with Web Audio (no audio files): countdown ticks and "go", a drum roll,
// the crowning, a fanfare on the results, a soft click on buttons, and two small cues for trouble.
//
// Everything goes through one quiet channel of its own. The clip's own sound (sound.ts) never passes through
// here and is never muted or lowered: these sounds sit under it. One switch, soundOn and setSound, turns these
// sounds and the spoken host (host.ts) off and on; the clip's sound does not follow it.

import { getSettings, onSettings, setSetting } from "./settings.ts";

/** How loud the whole channel is. Kept low so the clip always sits on top. */
const VOLUME = 0.22;

interface Channel { ctx: AudioContext; out: AudioNode }

let ctx: AudioContext | null = null;
let out: AudioNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

// ---- The switch and volume: from the settings store (settings.ts), which keeps jester.sound as it always was ----

/** True when the game's own sounds and the spoken host play. */
export function soundOn(): boolean {
  return getSettings().sound;
}

/** Turns the game's own sounds and the spoken host on or off, and remembers it. The clip's sound is not touched. */
export function setSound(next: boolean) {
  setSetting("sound", next);
}

// Switching off stops a line still being spoken; the volume follows the setting at once.
onSettings((s) => {
  if (!s.sound) { try { globalThis.speechSynthesis?.cancel(); } catch { /* no speech here */ } }
  if (out instanceof GainNode) out.gain.value = VOLUME * s.volume;
});

/** The sound channel, made on first use. Null when the browser has no Web Audio, or the switch is off. */
function channel(): Channel | null {
  if (!soundOn()) return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      const level = ctx.createGain();
      level.gain.value = VOLUME * getSettings().volume;
      // Stacked sounds (a crash on top of a roll) are evened out instead of clipping.
      const even = ctx.createDynamicsCompressor();
      even.threshold.value = -18;
      even.ratio.value = 4;
      level.connect(even).connect(ctx.destination);
      out = level;
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return { ctx, out: out! };
  } catch {
    return null;
  }
}

/**
 * Browsers start sound only after a click or key press. The first one on the page opens the channel, so a
 * sound that comes later (the countdown after Start) plays straight away.
 */
export function installSfx() {
  const open = () => { channel(); };
  window.addEventListener("pointerdown", open, { capture: true, passive: true });
  window.addEventListener("keydown", open, { capture: true });
}

/** A rise to `peak` in `attack` seconds, then a fall to silence over `decay` seconds, from `t`. */
function envelope(g: GainNode, t: number, peak: number, attack: number, decay: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

interface ToneOptions {
  freq: number;
  /** Seconds from now. */
  at?: number;
  /** Seconds from the peak to silence. */
  decay: number;
  type?: OscillatorType;
  peak?: number;
  attack?: number;
  /** Glide to this pitch over the decay. */
  glide?: number;
  /** A low-pass filter at this frequency, for a softer, brassier tone. */
  soften?: number;
  /** A gentle wobble in pitch, in Hz, for held notes. */
  vibrato?: number;
}

function tone(ch: Channel, o: ToneOptions) {
  const t = ch.ctx.currentTime + Math.max(0, o.at ?? 0);
  const attack = o.attack ?? 0.005;
  const osc = ch.ctx.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.glide, t + attack + o.decay);
  const g = ch.ctx.createGain();
  envelope(g, t, o.peak ?? 0.5, attack, o.decay);
  let last: AudioNode = osc;
  if (o.soften) {
    const f = ch.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = o.soften;
    last.connect(f);
    last = f;
  }
  if (o.vibrato) {
    const lfo = ch.ctx.createOscillator();
    const depth = ch.ctx.createGain();
    lfo.frequency.value = 5.5;
    depth.gain.value = o.vibrato;
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + attack + o.decay + 0.05);
  }
  last.connect(g).connect(ch.out);
  osc.start(t);
  osc.stop(t + attack + o.decay + 0.05);
}

interface NoiseOptions {
  at?: number;
  decay: number;
  peak?: number;
  attack?: number;
  filter?: BiquadFilterType;
  freq?: number;
  q?: number;
}

/** A burst of filtered noise: the snare, the cymbal and the paper tap are all this. */
function noise(ch: Channel, o: NoiseOptions) {
  if (!noiseBuffer) {
    const rate = ch.ctx.sampleRate;
    noiseBuffer = ch.ctx.createBuffer(1, rate, rate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = ch.ctx.currentTime + Math.max(0, o.at ?? 0);
  const attack = o.attack ?? 0.002;
  const src = ch.ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const f = ch.ctx.createBiquadFilter();
  f.type = o.filter ?? "bandpass";
  f.frequency.value = o.freq ?? 2000;
  f.Q.value = o.q ?? 1;
  const g = ch.ctx.createGain();
  envelope(g, t, o.peak ?? 0.5, attack, o.decay);
  src.connect(f).connect(g).connect(ch.out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + attack + o.decay + 0.05);
}

// Note names to Hz, for the tunes below.
const C4 = 261.63, E4 = 329.63, G4 = 392, A4 = 440, C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5;

/** A wooden tick for one second of the countdown. `left` is the seconds still to go; it rises as it nears go. */
export function tick(left = 3) {
  const ch = channel();
  if (!ch) return;
  const pitch = left <= 1 ? 1180 : left === 2 ? 990 : 880;
  tone(ch, { freq: pitch, decay: 0.09, type: "triangle", peak: 0.55 });
  noise(ch, { decay: 0.025, peak: 0.25, freq: 3500, q: 2 });
}

/** The countdown hits zero: a bright stab with a little whoosh. */
export function go() {
  const ch = channel();
  if (!ch) return;
  for (const f of [C5, E5, G5]) tone(ch, { freq: f, decay: 0.35, type: "triangle", peak: 0.3, glide: f * 1.02 });
  tone(ch, { freq: C6, at: 0.05, decay: 0.4, type: "sine", peak: 0.25 });
  noise(ch, { decay: 0.3, peak: 0.18, filter: "highpass", freq: 2500, attack: 0.04 });
}

/**
 * A snare drum roll that swells while it plays. Returns a function that ends it. With `ms`, it also ends by
 * itself after that long.
 */
export function drumRoll(ms?: number): () => void {
  const ch = channel();
  if (!ch) return () => {};
  const start = ch.ctx.currentTime;
  let next = start + 0.02;
  let stopped = false;
  // Hits are booked a little ahead on the audio clock, so a busy page does not make the roll stumble.
  const book = () => {
    if (!soundOn()) return end(); // switched off mid-roll
    const horizon = ch.ctx.currentTime + 0.25;
    while (next < horizon) {
      const swell = Math.min(1, 0.3 + (next - start) / 2.5);
      noise(ch, { at: next - ch.ctx.currentTime, decay: 0.08, peak: 0.42 * swell * (0.8 + Math.random() * 0.4), freq: 1900, q: 0.7 });
      // A little body under every few hits.
      if (Math.random() < 0.25) tone(ch, { freq: 190, at: next - ch.ctx.currentTime, decay: 0.06, type: "triangle", peak: 0.12 * swell });
      next += (1 / 22) * (0.9 + Math.random() * 0.2);
    }
  };
  book();
  const timer = window.setInterval(book, 60);
  const end = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(limit);
  };
  const limit = ms ? window.setTimeout(end, ms) : 0;
  return end;
}

/** The spotlight lands on the winner: a cymbal crash, a low drum and a "ta-da". */
export function crown() {
  const ch = channel();
  if (!ch) return;
  noise(ch, { decay: 1.8, peak: 0.5, filter: "highpass", freq: 5200, q: 0.5 });
  noise(ch, { decay: 0.9, peak: 0.25, freq: 9000, q: 0.6 });
  tone(ch, { freq: 120, decay: 0.45, type: "sine", peak: 0.7, glide: 60 });
  // Ta-da: a short note, then a long one held with a wobble.
  for (const [f, at, decay] of [[G4, 0.08, 0.14], [C5, 0.24, 1.1]] as const) {
    tone(ch, { freq: f, at, decay, type: "sawtooth", peak: 0.22, attack: 0.02, soften: 2200, vibrato: at > 0.2 ? 4 : 0 });
    tone(ch, { freq: f * 1.25, at, decay, type: "sawtooth", peak: 0.14, attack: 0.02, soften: 2200, vibrato: at > 0.2 ? 4 : 0 });
  }
}

/** The results: a short brass fanfare, da-da-da-daaa, then a chord. */
export function fanfare() {
  const ch = channel();
  if (!ch) return;
  const brass = (freq: number, at: number, decay: number, peak = 0.2) => {
    tone(ch, { freq, at, decay, type: "sawtooth", peak, attack: 0.025, soften: 2600, vibrato: decay > 0.4 ? 3 : 0 });
    tone(ch, { freq: freq * 2, at, decay, type: "triangle", peak: peak * 0.35, attack: 0.025 });
  };
  brass(G4, 0, 0.1);
  brass(G4, 0.15, 0.1);
  brass(G4, 0.3, 0.1);
  brass(C5, 0.45, 0.5, 0.24);
  brass(A4, 1.0, 0.12);
  brass(C5, 1.15, 0.12);
  for (const f of [C5, E5, G5]) brass(f, 1.3, 1.0, 0.16);
  tone(ch, { freq: C4, at: 1.3, decay: 1.0, type: "triangle", peak: 0.3 });
  noise(ch, { at: 1.3, decay: 1.2, peak: 0.25, filter: "highpass", freq: 6000, q: 0.5 });
}

/** A soft paper tap for a button. */
export function click() {
  const ch = channel();
  if (!ch) return;
  noise(ch, { decay: 0.03, peak: 0.22, freq: 2600, q: 1.5 });
  tone(ch, { freq: 620, decay: 0.04, type: "sine", peak: 0.12, glide: 520 });
}

/** The camera lost the player: a small questioning "hm?". */
export function lost() {
  const ch = channel();
  if (!ch) return;
  tone(ch, { freq: E5, decay: 0.12, type: "triangle", peak: 0.25 });
  tone(ch, { freq: G5, at: 0.13, decay: 0.18, type: "triangle", peak: 0.22 });
}

/** Something went wrong: a sad little slide down, like a trombone. */
export function oops() {
  const ch = channel();
  if (!ch) return;
  tone(ch, { freq: E4, decay: 0.28, type: "sawtooth", peak: 0.18, attack: 0.02, soften: 1400 });
  tone(ch, { freq: E4 * 0.94, at: 0.3, decay: 0.6, type: "sawtooth", peak: 0.18, attack: 0.02, soften: 1400, glide: E4 * 0.75, vibrato: 5 });
}
