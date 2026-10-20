// Deterministic Bumper Balls simulation. Runs only on the game server; clients
// send inputs and render the snapshots they receive.

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

export const RULES = {
  ballRadius: 1,
  arenaStart: 11,
  arenaMin: 3,
  shrinkStart: 3, // seconds into the match; the edge then creeps in steadily
  shrinkEnd: 70, // ~30% faster than the old 3s→90s close
  hardLimit: 90, // seconds; closest to center wins if still going
  accel: 16,
  drag: 1.1, // per second
  maxSpeed: 10,
  restitution: 1.2, // >1: the "bumper" kick
  minBounce: 6, // every hit separates at least this fast
  dashImpulse: 9,
  dashCooldown: 2.5,
  dashWindow: 0.4, // seconds after a dash that a hit counts as a dash hit (for effects only)
  spawnRadius: 6,
  edgeGrace: 0.4, // a ball only drops once its center is this far past the rim (most of it hanging off)
};

export type Input = { x: number; y: number; dash: boolean };

export type Ball = {
  seat: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
  outAt: number; // tick it fell, -1 if alive
  dashReadyAt: number; // tick
  input: Input;
  active: boolean; // ever sent an input
};

export type Sim = {
  tick: number;
  balls: Ball[];
  arena: number;
  over: boolean;
  winnerSeat: number | null; // null with over=true means no winner (refund)
  events: SimEvent[];
};

// da/db: whether ball a/b was mid-dash when they hit (both = a clash)
export type SimEvent = { t: "bump"; a: number; b: number; force: number; da?: 1; db?: 1 } | { t: "out"; seat: number } | { t: "dash"; seat: number };

export function createSim(players: number): Sim {
  const balls: Ball[] = [];
  for (let i = 0; i < players; i++) {
    const a = (i / players) * Math.PI * 2 + Math.PI / 4;
    balls.push({
      seat: i,
      x: Math.cos(a) * RULES.spawnRadius,
      y: Math.sin(a) * RULES.spawnRadius,
      vx: 0,
      vy: 0,
      alive: true,
      outAt: -1,
      dashReadyAt: 0,
      input: { x: 0, y: 0, dash: false },
      active: false,
    });
  }
  return { tick: 0, balls, arena: RULES.arenaStart, over: false, winnerSeat: null, events: [] };
}

function dashing(b: Ball, tick: number) {
  return b.dashReadyAt - tick > Math.round((RULES.dashCooldown - RULES.dashWindow) * TICK_HZ);
}

export function arenaRadiusAt(tick: number) {
  const t = tick / TICK_HZ;
  if (t <= RULES.shrinkStart) return RULES.arenaStart;
  const k = Math.min(1, (t - RULES.shrinkStart) / (RULES.shrinkEnd - RULES.shrinkStart));
  return RULES.arenaStart + (RULES.arenaMin - RULES.arenaStart) * k;
}

/** Sanitize an untrusted client input. */
export function cleanInput(raw: unknown): Input {
  const r = (raw ?? {}) as Record<string, unknown>;
  let x = Number(r.x);
  let y = Number(r.y);
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  return { x, y, dash: r.dash === true };
}

export function setInput(sim: Sim, seat: number, input: Input) {
  const b = sim.balls[seat];
  if (!b) return;
  if (input.x !== 0 || input.y !== 0 || input.dash) b.active = true;
  // a dash press latches until the next tick consumes it
  b.input = { x: input.x, y: input.y, dash: input.dash || b.input.dash };
}

export function step(sim: Sim) {
  if (sim.over) return;
  sim.events = [];
  sim.tick++;
  sim.arena = arenaRadiusAt(sim.tick);
  const R = RULES;
  const alive = sim.balls.filter((b) => b.alive);

  for (const b of alive) {
    // steering can't push you past maxSpeed, but it can always slow you down
    const ax = b.input.x * R.accel * DT;
    const ay = b.input.y * R.accel * DT;
    const before = Math.hypot(b.vx, b.vy);
    const after = Math.hypot(b.vx + ax, b.vy + ay);
    if (after <= R.maxSpeed || after < before) {
      b.vx += ax;
      b.vy += ay;
    }
    if (b.input.dash && sim.tick >= b.dashReadyAt) {
      const len = Math.hypot(b.input.x, b.input.y);
      if (len > 0.1) {
        b.vx += (b.input.x / len) * R.dashImpulse;
        b.vy += (b.input.y / len) * R.dashImpulse;
        b.dashReadyAt = sim.tick + Math.round(R.dashCooldown * TICK_HZ);
        sim.events.push({ t: "dash", seat: b.seat });
      }
    }
    b.input.dash = false;
    const damp = Math.max(0, 1 - R.drag * DT);
    b.vx *= damp;
    b.vy *= damp;
    const sp = Math.hypot(b.vx, b.vy);
    // hits and dashes can exceed maxSpeed, up to this hard cap
    if (sp > R.maxSpeed * 1.8) {
      b.vx *= (R.maxSpeed * 1.8) / sp;
      b.vy *= (R.maxSpeed * 1.8) / sp;
    }
    b.x += b.vx * DT;
    b.y += b.vy * DT;
  }

  // ball-ball collisions (equal mass)
  const d2min = (R.ballRadius * 2) ** 2;
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i];
      const b = alive[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= d2min || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      // push apart
      const overlap = R.ballRadius * 2 - d;
      a.x -= (nx * overlap) / 2;
      a.y -= (ny * overlap) / 2;
      b.x += (nx * overlap) / 2;
      b.y += (ny * overlap) / 2;
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny; // closing speed
      if (rel <= 0) continue;
      const imp = Math.max((rel * (1 + R.restitution)) / 2, R.minBounce / 2);
      a.vx -= imp * nx;
      a.vy -= imp * ny;
      b.vx += imp * nx;
      b.vy += imp * ny;
      const ev: SimEvent = { t: "bump", a: a.seat, b: b.seat, force: imp };
      if (dashing(a, sim.tick)) ev.da = 1;
      if (dashing(b, sim.tick)) ev.db = 1;
      sim.events.push(ev);
    }
  }

  // falling off
  for (const b of alive) {
    if (Math.hypot(b.x, b.y) > sim.arena + R.edgeGrace) {
      b.alive = false;
      b.outAt = sim.tick;
      sim.events.push({ t: "out", seat: b.seat });
    }
  }

  const left = sim.balls.filter((b) => b.alive);
  if (left.length === 1) return finish(sim, left[0].seat);
  if (left.length === 0) {
    // everyone remaining fell this tick: the one nearest the center wins
    const last = sim.balls.filter((b) => b.outAt === sim.tick);
    return finish(sim, nearest(last));
  }
  if (sim.tick >= R.hardLimit * TICK_HZ) return finish(sim, nearest(left));
}

function nearest(balls: Ball[]): number | null {
  const ds = balls.map((b) => Math.hypot(b.x, b.y)).sort((a, b) => a - b);
  if (ds.length > 1 && Math.abs(ds[0] - ds[1]) < 1e-6) return null; // exact tie: refund
  return balls.reduce((m, b) => (Math.hypot(b.x, b.y) < Math.hypot(m.x, m.y) ? b : m)).seat;
}

function finish(sim: Sim, seat: number | null) {
  sim.over = true;
  // nobody ever touched their controls: nothing was won, refund everyone
  sim.winnerSeat = sim.balls.some((b) => b.active) ? seat : null;
}

/** Compact snapshot sent to clients: [tick, arena, ...per-ball x,y,vx,vy,alive] */
export function snapshot(sim: Sim): number[] {
  const out = [sim.tick, round(sim.arena)];
  for (const b of sim.balls) out.push(round(b.x), round(b.y), round(b.vx), round(b.vy), b.alive ? 1 : 0, Math.max(0, b.dashReadyAt - sim.tick));
  return out;
}
export const SNAP_STRIDE = 6;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Simple practice bot: chase the nearest rival, stay away from the edge. */
export function botInput(sim: Sim, seat: number, level = 0.8): Input {
  const me = sim.balls[seat];
  const others = sim.balls.filter((b) => b.alive && b.seat !== seat);
  if (!me.alive || !others.length) return { x: 0, y: 0, dash: false };
  const target = others.reduce((m, b) => (Math.hypot(b.x - me.x, b.y - me.y) < Math.hypot(m.x - me.x, m.y - me.y) ? b : m));
  let x = target.x - me.x;
  let y = target.y - me.y;
  const r = Math.hypot(me.x, me.y);
  const edge = r / sim.arena;
  if (edge > 0.7) {
    // steer back toward center, harder near the edge
    const k = (edge - 0.7) * 6;
    x -= (me.x / r) * k * 4;
    y -= (me.y / r) * k * 4;
  }
  const len = Math.hypot(x, y) || 1;
  const dist = Math.hypot(target.x - me.x, target.y - me.y);
  return { x: (x / len) * level, y: (y / len) * level, dash: dist < 4 && Math.random() < 0.03 };
}
