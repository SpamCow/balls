// Race mode: three laps of a track with no walls. Run off the edge and you drop
// back onto the track a moment later where you left it. Weapons come from the
// battle code; ❓ boxes sit across the track, and running out of HP spins you
// out for a moment instead of knocking you out.
import { RULES, TICK_HZ, drive, collide, finish, type Sim, type Ball, type Input } from "./physics";
import { BATTLE, WEAPONS, AMMO, createBattleSim, useWeapon, runWeapon, projectiles, hurt, push, activeWeapon, nearestFoe } from "./battle";

export const RACE = {
  laps: 3,
  halfWidth: 4.5, // track half-width; a ball drops once its centre is edgeGrace past the edge
  edgeGrace: 0.4,
  fallSec: 1.3, // time off the track before you're put back
  spinSec: 1.2, // out of HP: you spin out for this long, then get your HP back
  hardLimit: 240, // seconds; whoever is furthest round wins
  boxAt: [0.16, 0.45, 0.74], // ❓ box rows, as a fraction of the lap
  boxLanes: [-2.6, 0, 2.6],
  boxR: 0.6,
  boxBack: 3, // seconds before a taken box reappears
  step: 0.5, // spacing of the track's centre-line samples
};

// The circuit, as control points of a closed curve (spline through them).
const CONTROL: [number, number][] = [
  [-34, -4], [-30, -20], [-14, -26], [2, -21], [16, -26], [32, -22],
  [37, -6], [30, 10], [16, 14], [6, 24], [-10, 27], [-27, 20],
];

export type TrackPoint = { x: number; y: number; tx: number; ty: number };

function buildTrack(): TrackPoint[] {
  const n = CONTROL.length;
  const cr = (i: number, t: number, k: 0 | 1) => {
    const [p0, p1, p2, p3] = [-1, 0, 1, 2].map((d) => CONTROL[(i + d + n) % n][k]);
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  };
  const dense: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < 60; j++) dense.push([cr(i, j / 60, 0), cr(i, j / 60, 1)]);
  const cum = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1];
    const b = dense[i % dense.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const L = cum[cum.length - 1];
  const N = Math.round(L / RACE.step);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0, j = 0; i < N; i++) {
    const s = (i * L) / N;
    while (cum[j + 1] < s) j++;
    const a = dense[j];
    const b = dense[(j + 1) % dense.length];
    const t = (s - cum[j]) / (cum[j + 1] - cum[j]);
    pts.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t });
  }
  return pts.map((p, i) => {
    const a = pts[(i - 1 + N) % N];
    const b = pts[(i + 1) % N];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { ...p, tx: (b.x - a.x) / len, ty: (b.y - a.y) / len };
  });
}

export const TRACK = buildTrack();
const N = TRACK.length;
const wrap = (i: number) => ((i % N) + N) % N;
const sec = (s: number) => Math.round(s * TICK_HZ);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Nearest centre-line sample to a point, searching around a hint (or everywhere), and how far off-centre it is. */
export function locate(x: number, y: number, hint = -1) {
  let best = 0;
  let bd = Infinity;
  const from = hint < 0 ? 0 : hint - 30;
  const to = hint < 0 ? N : hint + 30;
  for (let i = from; i < to; i++) {
    const p = TRACK[wrap(i)];
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = wrap(i);
    }
  }
  const p = TRACK[best];
  return { idx: best, off: (x - p.x) * -p.ty + (y - p.y) * p.tx }; // signed: + is left of the direction of travel
}

export const onTrack = (x: number, y: number) => Math.abs(locate(x, y).off) < RACE.halfWidth + 0.5;

/** Starting grid: two by two, behind the line. back = samples behind it. */
export function gridSpot(i: number) {
  const back = 5 + Math.floor(i / 2) * 5;
  const p = TRACK[wrap(-back)];
  const lane = i % 2 ? -1.8 : 1.8;
  return { back, x: p.x - p.ty * lane, y: p.y + p.tx * lane };
}

export type Racer = { prog: number; idx: number; fallUntil: number; spinUntil: number };
export type Race = {
  r: Racer[];
  boxes: { id: number; x: number; y: number; back: number }[];
};

export function createRaceSim(players: number): Sim {
  const sim = createBattleSim(players);
  const B = sim.battle!;
  sim.arena = 0;
  const r: Racer[] = sim.balls.map((b, i) => {
    const g = gridSpot(i);
    b.x = g.x;
    b.y = g.y;
    return { prog: -g.back, idx: wrap(-g.back), fallUntil: 0, spinUntil: 0 };
  });
  const boxes = RACE.boxAt.flatMap((f) =>
    RACE.boxLanes.map((lane) => {
      const p = TRACK[Math.round(f * N)];
      return { id: B.nextId++, x: p.x - p.ty * lane, y: p.y + p.tx * lane, back: 0 };
    }),
  );
  sim.race = { r, boxes };
  B.crates = boxes.map(({ id, x, y }) => ({ id, x, y }));
  B.onTrack = onTrack;
  B.aim = raceAim;
  B.rocketTarget = (s, owner, at) => racerAhead(s, owner) ?? nearestFoe(s, owner, at);
  return sim;
}

/** Shots go where you're heading, toward a rival if one is roughly in front. */
function raceAim(sim: Sim, b: Ball) {
  const rc = sim.race!.r[b.seat];
  const sp = Math.hypot(b.vx, b.vy);
  const t = TRACK[rc.idx];
  const hx = sp > 1 ? b.vx / sp : t.tx;
  const hy = sp > 1 ? b.vy / sp : t.ty;
  let best: Ball | null = null;
  for (const o of sim.balls) {
    if (!o.alive || o.seat === b.seat) continue;
    const d = dist(o, b);
    if (d > 25 || d < 0.01) continue;
    if (((o.x - b.x) * hx + (o.y - b.y) * hy) / d < 0.75) continue;
    if (!best || d < dist(best, b)) best = o;
  }
  if (!best) return { x: hx, y: hy };
  const d = dist(best, b);
  return { x: (best.x - b.x) / d, y: (best.y - b.y) / d };
}

/** The racer just in front of this one (null if they're leading). */
function racerAhead(sim: Sim, seat: number): Ball | null {
  const R = sim.race!;
  const mine = R.r[seat].prog;
  let best: Ball | null = null;
  for (const o of sim.balls) {
    if (!o.alive || o.seat === seat || R.r[o.seat].prog <= mine) continue;
    if (!best || R.r[o.seat].prog < R.r[best.seat].prog) best = o;
  }
  return best;
}

export const spinning = (sim: Sim, seat: number) => (sim.race?.r[seat].spinUntil ?? 0) > sim.tick;

export function stepRace(sim: Sim) {
  if (sim.over) return;
  const B = sim.battle!;
  const R = sim.race!;
  sim.events = [];
  sim.tick++;

  // back onto the track after a fall
  for (const b of sim.balls) {
    const rc = R.r[b.seat];
    if (b.alive || sim.tick < rc.fallUntil) continue;
    const p = TRACK[rc.idx];
    Object.assign(b, { alive: true, x: p.x, y: p.y, vx: p.tx * 2, vy: p.ty * 2 });
    sim.events.push({ t: "back", seat: b.seat });
  }
  const alive = sim.balls.filter((b) => b.alive);

  for (const b of alive) {
    const f = B.f[b.seat];
    const spin = spinning(sim, b.seat);
    if (spin) b.input = { x: 0, y: 0, dash: false };
    drive(sim, b, 1, spin ? 5 : RULES.drag);
    if (b.input.use && !spin) useWeapon(sim, b, f);
    b.input.use = false;
  }
  for (const b of alive) runWeapon(sim, b, B.f[b.seat]);

  // bumping is free in a race; only the spike shell stings
  collide(sim, alive, (a, b, _imp, nx, ny) => {
    const at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (activeWeapon(sim, a.seat) === "spikes") {
      hurt(sim, b, 30, "bump", at);
      push(b, nx, ny, BATTLE.spikes.knock);
    }
    if (activeWeapon(sim, b.seat) === "spikes") {
      hurt(sim, a, 30, "bump", at);
      push(a, -nx, -ny, BATTLE.spikes.knock);
    }
  });

  projectiles(sim);

  // ❓ boxes: drive through one for a weapon; it comes back a few seconds later
  for (const box of R.boxes) {
    if (box.back > sim.tick) continue;
    const b = alive.find((b) => !B.f[b.seat].weapon && dist(b, box) < RULES.ballRadius + RACE.boxR);
    if (!b) continue;
    box.back = sim.tick + sec(RACE.boxBack);
    const w = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
    Object.assign(B.f[b.seat], { weapon: w, ammo: AMMO[w], until: 0, readyAt: sim.tick + sec(0.2) });
    sim.events.push({ t: "crate", seat: b.seat, w });
  }
  B.crates = R.boxes.filter((x) => x.back <= sim.tick).map(({ id, x, y }) => ({ id, x, y }));

  for (const b of alive) {
    const f = B.f[b.seat];
    const rc = R.r[b.seat];
    if (f.hp <= 0) {
      // out of HP: spin out, then carry on with full health
      f.hp = BATTLE.hp;
      rc.spinUntil = sim.tick + sec(RACE.spinSec);
      sim.events.push({ t: "spin", seat: b.seat });
    }
    // how far round: only small steps along the centre line count, so cutting across doesn't
    const { idx, off } = locate(b.x, b.y, rc.idx);
    let d = idx - rc.idx;
    if (d > N / 2) d -= N;
    if (d < -N / 2) d += N;
    rc.idx = idx;
    rc.prog += d;
    if (Math.abs(off) > RACE.halfWidth + RACE.edgeGrace) {
      b.alive = false;
      b.outAt = sim.tick;
      rc.fallUntil = sim.tick + sec(RACE.fallSec);
      if (f.until) Object.assign(f, { weapon: null, until: 0 }); // a running hammer, magnet or spikes ends
      sim.events.push({ t: "fall", seat: b.seat });
    }
  }

  const done = sim.balls.filter((b) => R.r[b.seat].prog >= RACE.laps * N);
  if (done.length) return finish(sim, leader(sim, done));
  if (sim.tick >= sec(RACE.hardLimit)) return finish(sim, leader(sim, sim.balls));
}

function leader(sim: Sim, balls: Ball[]): number | null {
  const R = sim.race!;
  const sorted = [...balls].sort((a, b) => R.r[b.seat].prog - R.r[a.seat].prog);
  if (!sorted.length || (sorted.length > 1 && R.r[sorted[0].seat].prog === R.r[sorted[1].seat].prog)) return null;
  return sorted[0].seat;
}

/** Race state for clients: laps done so far (fractional) per seat, and who's spinning out. */
export function raceSnapshot(sim: Sim) {
  const R = sim.race!;
  return {
    p: R.r.map((r) => Math.round((r.prog / N) * 1000) / 1000),
    sp: R.r.map((r) => (r.spinUntil > sim.tick ? 1 : 0)),
  };
}
export type RaceSnap = ReturnType<typeof raceSnapshot>;

/** Practice bot: full throttle round the racing line, braking only as much as a bend needs; rams nearby
 * rivals on straights, dashes whenever it's lined up, and fires weapons as soon as there's a target. */
export function raceBotInput(sim: Sim, seat: number, level = 0.8): Input {
  const B = sim.battle!;
  const me = sim.balls[seat];
  const rc = sim.race!.r[seat];
  if (!me.alive || spinning(sim, seat)) return { x: 0, y: 0, dash: false };
  const f = B.f[seat];
  const speed = Math.hypot(me.vx, me.vy);
  const look = Math.round((2.5 + speed * 0.45) / RACE.step);
  const here = TRACK[rc.idx];
  let goal: { x: number; y: number } = TRACK[wrap(rc.idx + look)];
  // how sharp the road ahead turns, and the fastest speed that still makes the bend
  const span = look * 2 + 10;
  const far = TRACK[wrap(rc.idx + span)];
  const bend = Math.acos(Math.max(-1, Math.min(1, here.tx * far.tx + here.ty * far.ty)));
  const radius = bend > 0.01 ? (span * RACE.step) / bend : Infinity;
  const cap = Math.sqrt(RULES.accel * 0.85 * radius);
  const want = Math.min(RULES.maxSpeed * (1.1 + 0.3 * level), cap);
  const foe = nearestFoe(sim, seat, me);
  const foeD = foe ? dist(foe, me) : Infinity;
  const ahead = (p: { x: number; y: number }) => (p.x - me.x) * here.tx + (p.y - me.y) * here.ty;
  if (!f.weapon) {
    // empty-handed: steer through the nearest box coming up
    const box = sim.race!.boxes.find((x) => x.back <= sim.tick && dist(x, me) < 10 && ahead(x) > 1);
    if (box) goal = box;
  } else if (foe && foeD < 5 && bend < 0.5 && ahead(foe) > -1) {
    // a rival alongside or just in front on a straight: shove them toward the edge
    goal = { x: (goal.x + foe.x * 2) / 3, y: (goal.y + foe.y * 2) / 3 };
  }
  const gx = goal.x - me.x;
  const gy = goal.y - me.y;
  const gl = Math.hypot(gx, gy) || 1;
  let x = (gx / gl) * want - me.vx;
  let y = (gy / gl) * want - me.vy;
  const l = Math.hypot(x, y) || 1;
  [x, y] = l > 0.25 ? [x / l, y / l] : [x / 0.25, y / 0.25];
  // dash when lined up with the road (or a rival) and there's room to use it
  const along = speed > 0.1 ? (me.vx * here.tx + me.vy * here.ty) / speed : 0;
  const off = Math.abs(locate(me.x, me.y, rc.idx).off);
  const dash = sim.tick >= me.dashReadyAt && ((bend < 0.3 && along > 0.95 && off < 2.5) || (foe !== null && foeD < 2.6 && ahead(foe) > 0 && off < 3));
  let use = false;
  if (f.weapon && !activeWeapon(sim, seat)) {
    const w = f.weapon;
    const p = Math.random();
    const behind = sim.balls.some((o) => o.alive && o.seat !== seat && dist(o, me) < 10 && ahead(o) < -1);
    if (w === "laser" || w === "rocket") use = (racerAhead(sim, seat) !== null || foeD < 15) && p < 0.12;
    else if (w === "mine") use = behind ? p < 0.15 : p < 0.01;
    else use = foeD < 6 && p < 0.25;
  }
  return { x, y, dash, use };
}
