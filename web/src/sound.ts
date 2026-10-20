// Sound effects, synthesized with Web Audio so there are no files to load.
// Browsers only allow audio after the player interacts, so the context starts
// on the first click or key press.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
try {
  muted = localStorage.getItem("bb.muted") === "1";
} catch {}

function ac(): AudioContext | null {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC({ latencyHint: "interactive" });
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.7;
    // a gentle limiter so a pile of bumps never clips
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function unlockAudio() {
  const once = () => {
    ac();
    removeEventListener("pointerdown", once);
    removeEventListener("keydown", once);
  };
  addEventListener("pointerdown", once);
  addEventListener("keydown", once);
}

export function isMuted() {
  return muted;
}

export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem("bb.muted", m ? "1" : "0");
  } catch {}
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.7, ctx.currentTime, 0.02);
}

let lastBump = 0;

function tone(freq: number, dur: number, opts: { type?: OscillatorType; vol?: number; slideTo?: number; delay?: number; attack?: number } = {}) {
  const c = ac();
  if (!c || !master || muted) return;
  const t = c.currentTime + (opts.delay ?? 0);
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = opts.type ?? "sine";
  o.frequency.setValueAtTime(freq, t);
  if (opts.slideTo) o.frequency.exponentialRampToValueAtTime(opts.slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.vol ?? 0.3, t + (opts.attack ?? 0.005));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// One second of white noise, made once and reused by every hiss and thump.
let noiseBuffer: AudioBuffer | null = null;
function noiseBuf(c: AudioContext) {
  if (!noiseBuffer) {
    noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

function noise(dur: number, opts: { vol?: number; from?: number; to?: number; q?: number; delay?: number } = {}) {
  const c = ac();
  if (!c || !master || muted) return;
  const t = c.currentTime + (opts.delay ?? 0);
  const src = c.createBufferSource();
  src.buffer = noiseBuf(c);
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = opts.q ?? 1.2;
  f.frequency.setValueAtTime(opts.from ?? 800, t);
  f.frequency.exponentialRampToValueAtTime(opts.to ?? 800, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.vol ?? 0.3, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * (1 - dur));
  src.stop(t + dur + 0.02);
}

/** Two balls collide: a rubbery thump whose weight follows the hit's force. */
export function bump(force: number, mine: boolean) {
  const c = ac();
  if (!c || muted) return;
  const k = Math.min(1, force / 10);
  // a scrum of contacts reads as one hit, and other players' light taps stay quiet
  if (c.currentTime - lastBump < (mine ? 0.08 : 0.15)) return;
  if (!mine && k < 0.45) return;
  lastBump = c.currentTime;
  const vol = (mine ? 0.55 : 0.25) * (0.4 + 0.6 * k);
  tone(150 + 90 * k, 0.16, { type: "sine", vol, slideTo: 55 });
  tone(420 + 300 * k, 0.05, { type: "triangle", vol: vol * 0.5 });
  noise(0.06, { vol: vol * 0.35, from: 2400, to: 900, q: 0.8 });
}

/** A dash: a deep kick, a bright rising whoosh and a little "shing" on top. */
export function dash(mine = true) {
  const v = mine ? 1 : 0.35;
  tone(110, 0.18, { type: "sine", vol: 0.5 * v, slideTo: 45 }); // the kick you feel
  noise(0.28, { vol: 0.4 * v, from: 300, to: 5000, q: 2.2 }); // air rushing past
  tone(330, 0.2, { type: "sawtooth", vol: 0.07 * v, slideTo: 1320 });
  tone(2637, 0.22, { type: "triangle", vol: 0.07 * v, delay: 0.06 }); // shing
  tone(3520, 0.18, { type: "sine", vol: 0.05 * v, delay: 0.09 });
}

/** A dash lands on someone: a heavy smack with a crunchy crack. */
export function dashHit(mine: boolean) {
  const v = mine ? 1 : 0.5;
  lastBump = ac()?.currentTime ?? 0; // this replaces the ordinary bump sound
  tone(90, 0.35, { type: "sine", vol: 0.7 * v, slideTo: 35 });
  tone(240, 0.12, { type: "square", vol: 0.12 * v, slideTo: 80 });
  noise(0.12, { vol: 0.55 * v, from: 4000, to: 600, q: 0.7 });
  tone(1760, 0.15, { type: "triangle", vol: 0.08 * v, delay: 0.02, slideTo: 1200 });
}

/** Two dashes meet head on: a swelling rush, a huge metallic clang and a boom that rings out. */
export function clash() {
  lastBump = (ac()?.currentTime ?? 0) + 0.5;
  noise(0.18, { vol: 0.35, from: 600, to: 6000, q: 3 }); // the rush into each other
  const d = 0.12;
  tone(60, 1.1, { type: "sine", vol: 0.9, slideTo: 28, delay: d }); // boom
  noise(0.5, { vol: 0.6, from: 5000, to: 300, q: 0.6, delay: d });
  // clang: a cluster of inharmonic partials, like two blades meeting
  for (const [f, vol] of [[523, 0.16], [1187, 0.12], [1663, 0.1], [2489, 0.08], [3271, 0.06]] as const)
    tone(f, 1.2, { type: "triangle", vol, delay: d, slideTo: f * 0.985 });
  tone(1046.5, 0.6, { type: "square", vol: 0.05, delay: d + 0.05 });
  tone(2093, 0.9, { type: "sine", vol: 0.06, delay: d + 0.25 }); // the ring after
}

/** A ball goes over the edge: a falling whistle, louder when it's you. */
export function fall(mine: boolean) {
  tone(880, mine ? 0.7 : 0.45, { type: "triangle", vol: mine ? 0.3 : 0.14, slideTo: 110 });
  noise(0.25, { vol: mine ? 0.12 : 0.06, from: 1200, to: 200, delay: mine ? 0.55 : 0.35 });
}

/** Countdown: a short blip per second, and a brighter one on go. */
export function tick(go = false) {
  if (go) {
    tone(988, 0.25, { type: "square", vol: 0.12 });
    tone(1319, 0.3, { type: "square", vol: 0.08, delay: 0.05 });
  } else tone(660, 0.12, { type: "square", vol: 0.1 });
}

/** You win: a rising major arpeggio with a sparkle. */
export function win() {
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.35, { type: "triangle", vol: 0.22, delay: i * 0.09 }));
  [1568, 2093].forEach((f, i) => tone(f, 0.25, { type: "sine", vol: 0.08, delay: 0.38 + i * 0.07 }));
}

/** You lose: two soft descending notes. */
export function lose() {
  tone(392, 0.28, { type: "triangle", vol: 0.16 });
  tone(311.13, 0.45, { type: "triangle", vol: 0.16, delay: 0.22 });
}

/** A coin-like chime for money arriving (claim, deposit, collect). */
export function coin() {
  tone(1318.5, 0.08, { type: "square", vol: 0.08 });
  tone(1975.5, 0.3, { type: "square", vol: 0.08, delay: 0.07 });
}
