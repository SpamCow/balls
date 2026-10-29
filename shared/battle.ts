// Battle mode: a walled arena with a hole in the middle, health instead of
// edges, and weapon crates. Runs on the game server like the classic rules;
// every weapon aims itself, so the only control is one "use" button.
import { RULES, TICK_HZ, DT, createSim, drive, collide, dashing, finish, type Sim, type Ball, type Input } from "./physics";
import { think } from "./botbrain";

export const WEAPONS = ["hammer", "laser", "magnet", "spikes", "rocket", "mine"] as const;
export type Weapon = (typeof WEAPONS)[number];

export const BATTLE = {
  arena: 12, // wall radius
  hole: 2.4, // hole in the middle; a ball drops once its center is holeGrace inside it
  holeGrace: 0.4,
  holeMax: 7, // sudden death: the hole grows to this
  suddenDeath: 75, // seconds
  holeFull: 110,
  hardLimit: 120, // most HP left wins
  hp: 100,
  spawnRadius: 7,
  wallBounce: 0.8,
  bumpFree: 4, // impulse that does no damage (light taps)
  bumpDmg: 0.25, // damage per unit of impulse above that; weapons do the real damage
  dashDealt: 1.6, // a dashing ball hits harder...
  dashTaken: 0.5, // ...and takes less
  maxHit: 60,
  crateFirst: 1.5,
  crateEvery: 4,
  crateMax: 3,
  crateR: 0.6,
  hammer: { sec: 7, reach: 2.4, head: 0.75, minSpin: 2.5, maxSpin: 10, base: 8, extra: 32, cd: 0.4, knock: 10 },
  laser: { shots: 3, cd: 0.6, speed: 4.5, r: 0.3, dmg: 25, bounces: 2, knock: 5 },
  magnet: { sec: 2, pull: 8, accel: 22, fling: 4.5, flingSpeed: 12, dmg: 15 },
  spikes: { sec: 4, mult: 3, knock: 4 },
  rocket: { speed: 6, turn: 2.5, life: 6, blast: 3, dmg: 35, knock: 12, r: 0.35 },
  mine: { charges: 2, arm: 0.6, life: 20, r: 1.3, dmg: 25, kick: 14, max: 8 },
};

export type Fighter = {
  hp: number;
  weapon: Weapon | null;
  ammo: number; // shots or charges left
  until: number; // tick a timed weapon runs out (0 = not started)
  readyAt: number; // tick the next shot is allowed
  angle: number; // hammer head angle
  spin: number; // hammer spin, rad/s
  dir: number; // hammer spin direction, ±1
  heading: number; // last movement direction, for the hammer's spin
  hitCd: number[]; // per target: tick the hammer may hit them again
};

type P = { id: number; o: number; x: number; y: number };
export type Battle = {
  f: Fighter[];
  hole: number;
  crates: { id: number; x: number; y: number }[];
  lasers: (P & { vx: number; vy: number; n: number })[]; // n = wall hits so far
  rockets: (P & { vx: number; vy: number; die: number; t?: number })[]; // t: the seat it's locked onto (race)
  mines: (P & { arm: number; die: number })[];
  nextCrate: number;
  nextId: number;
  // race mode swaps in its own aiming and its own idea of where shots can fly (see race.ts)
  aim?: (sim: Sim, b: Ball) => { x: number; y: number };
  rocketTarget?: (sim: Sim, owner: number, at: { x: number; y: number }) => Ball | null; // set: rockets launch straight at it and stay locked on
  rocket?: { speed: number; turn: number };
  onTrack?: (x: number, y: number) => boolean;
};

type HitKind = "bump" | "hammer" | "laser" | "magnet" | "rocket" | "mine";
export type BattleEvent =
  | { t: "hit"; seat: number; dmg: number; x: number; y: number; k: HitKind }
  | { t: "crate"; seat: number; w: Weapon }
  | { t: "use"; seat: number; w: Weapon }
  | { t: "boom"; x: number; y: number; r: number };

const sec = (s: number) => Math.round(s * TICK_HZ);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const r1 = (n: number) => Math.round(n * 10) / 10;

export function createBattleSim(players: number): Sim {
  const sim = createSim(players);
  for (const b of sim.balls) {
    const a = Math.atan2(b.y, b.x);
    b.x = Math.cos(a) * BATTLE.spawnRadius;
    b.y = Math.sin(a) * BATTLE.spawnRadius;
  }
  sim.arena = BATTLE.arena;
  sim.battle = {
    f: sim.balls.map(() => ({ hp: BATTLE.hp, weapon: null, ammo: 0, until: 0, readyAt: 0, angle: 0, spin: 0, dir: 1, heading: 0, hitCd: Array(players).fill(0) })),
    hole: BATTLE.hole,
    crates: [],
    lasers: [],
    rockets: [],
    mines: [],
    nextCrate: sec(BATTLE.crateFirst),
    nextId: 1,
  };
  return sim;
}

export function holeAt(tick: number) {
  const t = tick / TICK_HZ;
  if (t <= BATTLE.suddenDeath) return BATTLE.hole;
  const k = Math.min(1, (t - BATTLE.suddenDeath) / (BATTLE.holeFull - BATTLE.suddenDeath));
  return BATTLE.hole + (BATTLE.holeMax - BATTLE.hole) * k;
}

export function hurt(sim: Sim, victim: Ball, dmg: number, k: HitKind, at: { x: number; y: number } = victim) {
  const f = sim.battle!.f[victim.seat];
  dmg = Math.min(BATTLE.maxHit, dmg);
  if (dmg < 0.5 || !victim.alive) return;
  f.hp -= dmg;
  sim.events.push({ t: "hit", seat: victim.seat, dmg: Math.round(dmg), x: r1(at.x), y: r1(at.y), k });
}

export function push(b: Ball, nx: number, ny: number, speed: number) {
  const len = Math.hypot(nx, ny) || 1;
  b.vx += (nx / len) * speed;
  b.vy += (ny / len) * speed;
}

/** The nearest living rival to a point, or null. */
export function nearestFoe(sim: Sim, seat: number, from: { x: number; y: number }) {
  let best: Ball | null = null;
  for (const o of sim.balls) if (o.alive && o.seat !== seat && (!best || dist(o, from) < dist(best, from))) best = o;
  return best;
}

function aimAt(sim: Sim, b: Ball) {
  if (sim.battle!.aim) return sim.battle!.aim(sim, b);
  const t = nearestFoe(sim, b.seat, b);
  let dx = t ? t.x - b.x : b.vx;
  let dy = t ? t.y - b.y : b.vy;
  if (Math.hypot(dx, dy) < 0.01) [dx, dy] = [1, 0];
  const len = Math.hypot(dx, dy);
  return { x: dx / len, y: dy / len };
}

export const AMMO: Record<Weapon, number> = { hammer: 0, laser: BATTLE.laser.shots, magnet: 0, spikes: 0, rocket: 1, mine: BATTLE.mine.charges };
const TIMED: Partial<Record<Weapon, number>> = { hammer: BATTLE.hammer.sec, magnet: BATTLE.magnet.sec, spikes: BATTLE.spikes.sec };

/** Is this ball's timed weapon (hammer, magnet, spikes) running? */
export function activeWeapon(sim: Sim, seat: number): Weapon | null {
  const f = sim.battle?.f[seat];
  return f && f.weapon && f.until > sim.tick ? f.weapon : null;
}

export function useWeapon(sim: Sim, b: Ball, f: Fighter) {
  const B = sim.battle!;
  const w = f.weapon;
  if (!w || f.until > 0 || sim.tick < f.readyAt) return;
  const id = B.nextId++;
  if (TIMED[w]) {
    f.until = sim.tick + sec(TIMED[w]!);
    if (w === "hammer") {
      f.spin = BATTLE.hammer.minSpin;
      f.angle = Math.atan2(b.vy, b.vx);
      f.heading = f.angle;
    }
  } else if (w === "laser") {
    const d = aimAt(sim, b);
    B.lasers.push({ id, o: b.seat, x: b.x + d.x * 1.4, y: b.y + d.y * 1.4, vx: d.x * BATTLE.laser.speed, vy: d.y * BATTLE.laser.speed, n: 0 });
    f.readyAt = sim.tick + sec(BATTLE.laser.cd);
  } else if (w === "rocket") {
    const lock = B.rocketTarget?.(sim, b.seat, b) ?? null;
    let d = aimAt(sim, b);
    if (lock) {
      const len = dist(lock, b) || 1;
      d = { x: (lock.x - b.x) / len, y: (lock.y - b.y) / len };
    }
    const speed = B.rocket?.speed ?? BATTLE.rocket.speed;
    B.rockets.push({ id, o: b.seat, x: b.x + d.x * 1.5, y: b.y + d.y * 1.5, vx: d.x * speed, vy: d.y * speed, die: sim.tick + sec(BATTLE.rocket.life), t: lock?.seat });
  } else if (w === "mine") {
    // dropped just behind you
    const sp = Math.hypot(b.vx, b.vy);
    const bx = sp > 0.5 ? -b.vx / sp : 0;
    const by = sp > 0.5 ? -b.vy / sp : 0;
    B.mines.push({ id, o: b.seat, x: b.x + bx * 1.6, y: b.y + by * 1.6, arm: sim.tick + sec(BATTLE.mine.arm), die: sim.tick + sec(BATTLE.mine.life) });
    if (B.mines.length > BATTLE.mine.max) B.mines.shift();
    f.readyAt = sim.tick + sec(0.3);
  }
  sim.events.push({ t: "use", seat: b.seat, w });
  if (!TIMED[w] && --f.ammo <= 0) f.weapon = null;
}

/** Timed weapons while they run: the hammer swings, the magnet pulls. */
export function runWeapon(sim: Sim, b: Ball, f: Fighter) {
  const B = sim.battle!;
  const w = f.weapon;
  if (!w || !f.until) return;
  if (sim.tick >= f.until) {
    if (w === "magnet") {
      // the pull ends in a fling
      for (const o of sim.balls) {
        if (!o.alive || o.seat === b.seat || dist(o, b) > BATTLE.magnet.fling) continue;
        const dx = o.x - b.x;
        const dy = o.y - b.y;
        const len = Math.hypot(dx, dy) || 1;
        o.vx = (dx / len) * BATTLE.magnet.flingSpeed;
        o.vy = (dy / len) * BATTLE.magnet.flingSpeed;
        hurt(sim, o, BATTLE.magnet.dmg, "magnet");
      }
      sim.events.push({ t: "boom", x: r1(b.x), y: r1(b.y), r: BATTLE.magnet.fling });
    }
    f.weapon = null;
    f.until = 0;
    return;
  }
  if (w === "hammer") {
    const H = BATTLE.hammer;
    // circling spins it up; going straight lets it wind down
    let turn = 0;
    if (Math.hypot(b.vx, b.vy) > 1) {
      const h = Math.atan2(b.vy, b.vx);
      let dh = h - f.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      f.heading = h;
      turn = dh / DT;
      if (Math.abs(turn) > 0.5) f.dir = Math.sign(turn);
    }
    const want = Math.min(H.maxSpin, H.minSpin + Math.abs(turn) * 2.5);
    f.spin += (want - f.spin) * Math.min(1, 3 * DT);
    f.angle += f.spin * f.dir * DT;
    const head = { x: b.x + Math.cos(f.angle) * H.reach, y: b.y + Math.sin(f.angle) * H.reach };
    const power = (f.spin - H.minSpin) / (H.maxSpin - H.minSpin);
    for (const o of sim.balls) {
      if (!o.alive || o.seat === b.seat || sim.tick < f.hitCd[o.seat] || dist(o, head) > RULES.ballRadius + H.head) continue;
      f.hitCd[o.seat] = sim.tick + sec(H.cd);
      push(o, o.x - head.x, o.y - head.y, H.knock * (0.5 + power));
      hurt(sim, o, H.base + H.extra * power, "hammer", head);
    }
  } else if (w === "magnet") {
    for (const o of sim.balls) {
      if (!o.alive || o.seat === b.seat) continue;
      const d = dist(o, b);
      if (d > BATTLE.magnet.pull || d < 0.01) continue;
      o.vx += ((b.x - o.x) / d) * BATTLE.magnet.accel * DT;
      o.vy += ((b.y - o.y) / d) * BATTLE.magnet.accel * DT;
    }
  }
}

function explode(sim: Sim, owner: number, x: number, y: number) {
  const R = BATTLE.rocket;
  for (const o of sim.balls) {
    if (!o.alive || o.seat === owner) continue;
    const d = Math.hypot(o.x - x, o.y - y);
    if (d > R.blast) continue;
    push(o, o.x - x || 0.01, o.y - y, R.knock * (1 - 0.4 * (d / R.blast)));
    hurt(sim, o, R.dmg * (1 - 0.5 * (d / R.blast)), "rocket", { x, y });
  }
  sim.events.push({ t: "boom", x: r1(x), y: r1(y), r: R.blast });
}

export function projectiles(sim: Sim) {
  const B = sim.battle!;
  const wallR = (r: number) => BATTLE.arena - r;

  B.lasers = B.lasers.filter((l) => {
    l.x += l.vx * DT;
    l.y += l.vy * DT;
    const r = Math.hypot(l.x, l.y);
    if (B.onTrack) {
      if (!B.onTrack(l.x, l.y)) return false; // race: a shot that leaves the track is gone
    } else if (r > wallR(BATTLE.laser.r)) {
      // bounces off the wall twice, gone on the third hit
      if (++l.n > BATTLE.laser.bounces) return false;
      const nx = l.x / r;
      const ny = l.y / r;
      const vn = l.vx * nx + l.vy * ny;
      l.vx -= 2 * vn * nx;
      l.vy -= 2 * vn * ny;
      l.x = nx * wallR(BATTLE.laser.r);
      l.y = ny * wallR(BATTLE.laser.r);
    }
    for (const o of sim.balls) {
      // a shot can't hit the one who fired it until it has bounced
      if (!o.alive || (o.seat === l.o && l.n === 0) || dist(o, l) > RULES.ballRadius + BATTLE.laser.r) continue;
      push(o, l.vx, l.vy, BATTLE.laser.knock);
      hurt(sim, o, BATTLE.laser.dmg, "laser", l);
      return false;
    }
    return true;
  });

  B.rockets = B.rockets.filter((m) => {
    const R = { ...BATTLE.rocket, ...B.rocket };
    const locked = m.t !== undefined ? sim.balls[m.t] : undefined;
    const t = locked?.alive ? locked : B.rocketTarget ? B.rocketTarget(sim, m.o, m) : nearestFoe(sim, m.o, m);
    if (t) {
      // turn toward the nearest rival, at most R.turn rad/s
      const cur = Math.atan2(m.vy, m.vx);
      let d = Math.atan2(t.y - m.y, t.x - m.x) - cur;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const a = cur + Math.max(-R.turn * DT, Math.min(R.turn * DT, d));
      m.vx = Math.cos(a) * R.speed;
      m.vy = Math.sin(a) * R.speed;
    }
    m.x += m.vx * DT;
    m.y += m.vy * DT;
    const hit = sim.balls.some((o) => o.alive && o.seat !== m.o && dist(o, m) < RULES.ballRadius + R.r);
    if (hit || (!B.onTrack && Math.hypot(m.x, m.y) > wallR(R.r)) || sim.tick >= m.die) {
      explode(sim, m.o, m.x, m.y);
      return false;
    }
    return true;
  });

  B.mines = B.mines.filter((m) => {
    if (sim.tick >= m.die) return false;
    if (sim.tick < m.arm) return true;
    // once armed it goes off under anyone, including whoever dropped it
    const o = sim.balls.find((o) => o.alive && dist(o, m) < BATTLE.mine.r);
    if (!o) return true;
    // sends you flying back the way you came
    const sp = Math.hypot(o.vx, o.vy);
    const [dx, dy] = sp > 0.5 ? [-o.vx / sp, -o.vy / sp] : [(o.x - m.x) || 1, o.y - m.y];
    o.vx = 0;
    o.vy = 0;
    push(o, dx, dy, BATTLE.mine.kick);
    hurt(sim, o, BATTLE.mine.dmg, "mine", m);
    sim.events.push({ t: "boom", x: r1(m.x), y: r1(m.y), r: BATTLE.mine.r * 1.5 });
    return false;
  });

}

function crates(sim: Sim, alive: Ball[]) {
  const B = sim.battle!;
  for (const b of alive) {
    const f = B.f[b.seat];
    if (f.weapon) continue;
    const i = B.crates.findIndex((c) => dist(c, b) < RULES.ballRadius + BATTLE.crateR);
    if (i < 0) continue;
    B.crates.splice(i, 1);
    const w = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
    Object.assign(f, { weapon: w, ammo: AMMO[w], until: 0, readyAt: sim.tick + sec(0.2) });
    sim.events.push({ t: "crate", seat: b.seat, w });
  }
  if (sim.tick >= B.nextCrate) {
    B.nextCrate = sim.tick + sec(BATTLE.crateEvery);
    if (B.crates.length >= Math.min(BATTLE.crateMax, sim.balls.length)) return;
    for (let tries = 0; tries < 12; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * (BATTLE.arena - 1.5 - (B.hole + 1.5)) + B.hole + 1.5;
      const c = { id: B.nextId++, x: Math.cos(a) * r, y: Math.sin(a) * r };
      if (alive.some((b) => dist(b, c) < 2.5) || B.crates.some((o) => dist(o, c) < 2)) continue;
      B.crates.push(c);
      break;
    }
  }
}

export function stepBattle(sim: Sim) {
  if (sim.over) return;
  const B = sim.battle!;
  sim.events = [];
  sim.tick++;
  B.hole = holeAt(sim.tick);
  const alive = sim.balls.filter((b) => b.alive);

  for (const b of alive) {
    const f = B.f[b.seat];
    drive(sim, b);
    if (b.input.use) useWeapon(sim, b, f);
    b.input.use = false;
  }

  // the wall: bounce back in
  for (const b of alive) {
    const r = Math.hypot(b.x, b.y);
    const lim = BATTLE.arena - RULES.ballRadius;
    if (r <= lim) continue;
    const nx = b.x / r;
    const ny = b.y / r;
    b.x = nx * lim;
    b.y = ny * lim;
    const vn = b.vx * nx + b.vy * ny;
    if (vn > 0) {
      b.vx -= (1 + BATTLE.wallBounce) * vn * nx;
      b.vy -= (1 + BATTLE.wallBounce) * vn * ny;
    }
  }

  for (const b of alive) runWeapon(sim, b, B.f[b.seat]);

  collide(sim, alive, (a, b, imp, nx, ny) => {
    const base = Math.max(0, imp - BATTLE.bumpFree) * BATTLE.bumpDmg;
    const da = dashing(a, sim.tick);
    const db = dashing(b, sim.tick);
    const sa = activeWeapon(sim, a.seat) === "spikes";
    const sb = activeWeapon(sim, b.seat) === "spikes";
    const at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const toB = base * (da ? BATTLE.dashDealt : 1) * (db ? BATTLE.dashTaken : 1) * (sa ? BATTLE.spikes.mult : 1);
    const toA = base * (db ? BATTLE.dashDealt : 1) * (da ? BATTLE.dashTaken : 1) * (sb ? BATTLE.spikes.mult : 1);
    // spikes always sting, even on a light touch
    hurt(sim, b, sa ? Math.max(toB, 10) : toB, "bump", at);
    hurt(sim, a, sb ? Math.max(toA, 10) : toA, "bump", at);
    if (sa) push(b, nx, ny, BATTLE.spikes.knock);
    if (sb) push(a, -nx, -ny, BATTLE.spikes.knock);
  });

  projectiles(sim);
  crates(sim, alive);

  for (const b of alive) {
    const f = B.f[b.seat];
    const cause = f.hp <= 0 ? "ko" : Math.hypot(b.x, b.y) < B.hole - BATTLE.holeGrace ? "hole" : null;
    if (!cause) continue;
    b.alive = false;
    b.outAt = sim.tick;
    f.weapon = null;
    sim.events.push({ t: "out", seat: b.seat, cause });
  }

  const left = sim.balls.filter((b) => b.alive);
  if (left.length === 1) return finish(sim, left[0].seat);
  if (left.length === 0) return finish(sim, mostHp(sim, sim.balls.filter((b) => b.outAt === sim.tick)));
  if (sim.tick >= sec(BATTLE.hardLimit)) return finish(sim, mostHp(sim, left));
}

function mostHp(sim: Sim, balls: Ball[]): number | null {
  const hp = (b: Ball) => sim.battle!.f[b.seat].hp;
  const sorted = [...balls].sort((a, b) => hp(b) - hp(a));
  if (!sorted.length || (sorted.length > 1 && hp(sorted[0]) === hp(sorted[1]))) return null;
  return sorted[0].seat;
}

/** Battle state for clients, sent next to the classic snapshot. */
export function battleSnapshot(sim: Sim) {
  const B = sim.battle!;
  const xy = (p: { x: number; y: number }) => [r1(p.x), r1(p.y)];
  return {
    hp: B.f.map((f) => Math.max(0, Math.ceil(f.hp))),
    w: B.f.map((f) => (f.weapon ? WEAPONS.indexOf(f.weapon) : -1)),
    n: B.f.map((f) => f.ammo),
    on: B.f.map((f) => (f.weapon && f.until > sim.tick ? f.until - sim.tick : 0)), // ticks left on a running weapon
    ang: B.f.map((f) => Math.round(f.angle * 100) / 100),
    hole: Math.round(B.hole * 100) / 100,
    c: B.crates.flatMap((c) => [c.id, ...xy(c)]),
    l: B.lasers.flatMap((l) => [l.id, ...xy(l), l.o]), // o: who fired it, for its colour
    r: B.rockets.flatMap((m) => [m.id, ...xy(m), Math.round(Math.atan2(m.vy, m.vx) * 100) / 100]),
    m: B.mines.flatMap((m) => [m.id, ...xy(m), sim.tick >= m.arm ? 1 : 0, m.o]),
  };
}
export type BattleSnap = ReturnType<typeof battleSnapshot>;

/** Practice bot for battle mode: its own personality and plans (botbrain.ts), grabs crates, uses weapons
 * near people, stays out of the hole. */
export function battleBotInput(sim: Sim, seat: number, level = 0.8): Input {
  const B = sim.battle!;
  const me = sim.balls[seat];
  const f = B.f[seat];
  const foe = nearestFoe(sim, seat, me);
  if (!me.alive || !foe) return { x: 0, y: 0, dash: false };
  const t = think(sim, seat, BATTLE.arena, B.hole);
  const { p } = t.m;
  const foeD = dist(foe, me);
  let x = t.x;
  let y = t.y;
  let dash = t.dash;
  if (!f.weapon) {
    const crate = B.crates.reduce<{ x: number; y: number } | null>((m, c) => (!m || dist(c, me) < dist(m, me) ? c : m), null);
    if (crate && dist(crate, me) < foeD * p.crateGreed) {
      const cl = dist(crate, me) || 1;
      [x, y] = [(crate.x - me.x) / cl, (crate.y - me.y) / cl];
      dash = false;
    }
  }
  const running = activeWeapon(sim, seat);
  const tgt = t.target ?? foe;
  const tD = dist(tgt, me);
  if (running === "hammer" && tD < 5) {
    // circle the target so the hammer spins up
    const len = tD || 1;
    const ux = (tgt.x - me.x) / len;
    const uy = (tgt.y - me.y) / len;
    [x, y] = [-uy * t.m.side + ux * 0.3, ux * t.m.side + uy * 0.3];
  }
  // ease towards the new heading instead of snapping to it
  const k = 1 / p.react;
  x = t.m.last.x + (x - t.m.last.x) * k;
  y = t.m.last.y + (y - t.m.last.y) * k;
  t.m.last = { x, y, dash: false };
  // stay clear of the hole, looking a little ahead
  const ahead = { x: me.x + me.vx * 0.4, y: me.y + me.vy * 0.4 };
  const r = Math.hypot(ahead.x, ahead.y);
  const safe = B.hole + 2.2 + p.caution * 1.6;
  if (r < safe) {
    const kk = ((safe - r) / safe) * 10;
    const len0 = Math.hypot(x, y) || 1;
    x = x / len0 + (ahead.x / (r || 1)) * kk;
    y = y / len0 + (ahead.y / (r || 1)) * kk;
    // heading inward fast: don't dash into the hole
    if ((me.vx * me.x + me.vy * me.y) / (Math.hypot(me.x, me.y) || 1) < -1) dash = false;
  }
  const len = Math.hypot(x, y) || 1;
  let use = false;
  if (f.weapon && !running) {
    const w = f.weapon;
    const q = Math.random() / p.trigger;
    const range = 4 + p.aggro * 3;
    if (w === "laser" || w === "rocket") use = q < 0.04;
    else if (w === "hammer" || w === "spikes" || w === "magnet") use = tD < (w === "magnet" ? 5 : range) && q < 0.08;
    else if (w === "mine") use = foeD < 7 && q < 0.03;
  }
  const g = Math.min(1, level * p.throttle);
  return { x: (x / len) * g, y: (y / len) * g, dash, use };
}
