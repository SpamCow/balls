// Bot personalities and plans, so bots don't all just beeline for the nearest ball.
// Each bot gets a random personality per match and keeps switching between short plans
// (hunt, flank, circle, juke, bait, wander, vulture). Server-only: Math.random is fine here.
import type { Ball, Input, Sim } from "./physics";
import { dashing } from "./physics";

export type Persona = {
  aggro: number; // 0..1: how much it hunts instead of hanging back
  caution: number; // 0..1: how early it turns away from the edge
  dashy: number; // 0..1: how keen it is to dash
  react: number; // ticks between fresh decisions (a human-ish delay)
  throttle: number; // how hard it pushes the stick
  wobble: number; // how much its line wavers
  freq: number;
  phase: number;
  crateGreed: number; // battle: how far it'll go for a crate
  trigger: number; // battle/race: how quickly it fires weapons
  lane: number; // race: which side of the road it likes
};

export type Plan = "hunt" | "flank" | "circle" | "juke" | "bait" | "wander" | "vulture";

type Mind = {
  p: Persona;
  plan: Plan;
  until: number;
  target: number | null;
  grudge: number | null;
  side: 1 | -1;
  spot: { x: number; y: number };
  nextThink: number;
  last: Input;
  dodgeUntil: number;
  dodge: { x: number; y: number };
};

const minds = new WeakMap<Sim, (Mind | undefined)[]>();
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(w: [T, number][]): T => {
  let r = Math.random() * w.reduce((s, [, n]) => s + n, 0);
  for (const [v, n] of w) if ((r -= n) <= 0) return v;
  return w[w.length - 1][0];
};
const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function newPersona(): Persona {
  // a few archetypes, then jittered so no two bots feel the same
  const kind = pick<[number, number, number]>([
    [[0.9, 0.3, 0.8], 3], // bully: hunts, dashes a lot, a bit reckless
    [[0.5, 0.6, 0.5], 3], // all-rounder
    [[0.25, 0.8, 0.35], 2], // survivor: plays safe and lets others fight
    [[0.7, 0.45, 0.95], 2], // trickster: jukes and dashes
  ]);
  const j = (v: number) => Math.min(1, Math.max(0, v + rnd(-0.15, 0.15)));
  return {
    aggro: j(kind[0]),
    caution: j(kind[1]),
    dashy: j(kind[2]),
    react: Math.round(rnd(3, 12)),
    throttle: rnd(0.8, 1.05),
    wobble: rnd(0.05, 0.35),
    freq: rnd(0.6, 2),
    phase: rnd(0, Math.PI * 2),
    crateGreed: rnd(0.9, 2),
    trigger: rnd(0.5, 1.6),
    lane: rnd(-1.4, 1.4),
  };
}

export function mind(sim: Sim, seat: number): Mind {
  let all = minds.get(sim);
  if (!all) minds.set(sim, (all = []));
  return (all[seat] ??= {
    p: newPersona(),
    plan: "wander",
    until: 0,
    target: null,
    grudge: null,
    side: Math.random() < 0.5 ? 1 : -1,
    spot: { x: 0, y: 0 },
    nextThink: 0,
    last: { x: 0, y: 0, dash: false },
    dodgeUntil: 0,
    dodge: { x: 0, y: 0 },
  });
}

/** 0 = safe, 1 = about to drop: near the rim in classic, near the hole in battle. */
function danger(b: { x: number; y: number }, arena: number, hole: number | null) {
  const r = Math.hypot(b.x, b.y);
  return hole === null ? r / arena : 1 - Math.min(1, Math.max(0, (r - hole) / (arena - hole)));
}

/** Remember who just bumped us hard: some bots hold a grudge. */
function noteHits(sim: Sim, m: Mind, seat: number) {
  for (const e of sim.events) {
    if (e.t !== "bump" || e.force < 1.5) continue;
    const other = e.a === seat ? e.b : e.b === seat ? e.a : null;
    if (other !== null && Math.random() < 0.35 * m.p.aggro + 0.1) m.grudge = other;
  }
  if (m.grudge !== null && !sim.balls[m.grudge]?.alive) m.grudge = null;
}

function choosePlan(sim: Sim, m: Mind, me: Ball, foes: Ball[], arena: number, hole: number | null) {
  const a = m.p.aggro;
  const crowd = foes.length >= 2;
  m.plan = pick<Plan>([
    ["hunt", 1 + a * 2],
    ["flank", 1 + a],
    ["circle", 1],
    ["juke", 0.4 + m.p.dashy],
    ["bait", 1.4 - a],
    ["wander", 0.6 - a * 0.4],
    ["vulture", crowd ? 1.6 - a : 0],
  ]);
  m.until = sim.tick + Math.round(rnd(0.8, 3.2) * 60);
  m.side = Math.random() < 0.5 ? 1 : -1;
  // who to go after: the nearest, whoever is closest to falling, a grudge, or anyone
  const near = foes.reduce((x, b) => (d(b, me) < d(x, me) ? b : x));
  const edgy = foes.reduce((x, b) => (danger(b, arena, hole) > danger(x, arena, hole) ? b : x));
  const grudge = m.grudge !== null ? sim.balls[m.grudge] : null;
  m.target = pick<number>([
    [near.seat, 3],
    [edgy.seat, 1 + a],
    [grudge?.alive ? grudge.seat : near.seat, grudge?.alive ? 2 : 0],
    [foes[Math.floor(Math.random() * foes.length)].seat, 1],
  ]);
  const ang = rnd(0, Math.PI * 2);
  const rr = hole === null ? rnd(0, 0.45) * arena : rnd(hole + 3.5, arena - 2.5);
  m.spot = { x: Math.cos(ang) * rr, y: Math.sin(ang) * rr };
}

/**
 * Where this bot wants to steer this tick, before edge/hole safety is added.
 * Returns a direction (not normalised), whether it wants to dash, and the ball it's after.
 */
export function think(sim: Sim, seat: number, arena: number, hole: number | null = null): { x: number; y: number; dash: boolean; target: Ball | null; plan: Plan; m: Mind } {
  const me = sim.balls[seat];
  const m = mind(sim, seat);
  const foes = sim.balls.filter((b) => b.alive && b.seat !== seat);
  noteHits(sim, m, seat);
  if (!foes.length) return { x: -me.x, y: -me.y, dash: false, target: null, plan: m.plan, m };
  if (sim.tick >= m.until || m.target === null || !sim.balls[m.target].alive) choosePlan(sim, m, me, foes, arena, hole);
  const t = sim.balls[m.target!];
  const dx = t.x - me.x;
  const dy = t.y - me.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  let x = ux;
  let y = uy;
  let dash = false;
  const ready = sim.tick >= me.dashReadyAt;
  const tr = Math.hypot(t.x, t.y);
  const tEdge = danger(t, arena, hole);
  // a lined-up dash: heading at the target and close enough to connect
  const sp = Math.hypot(me.vx, me.vy) || 1;
  const lined = (me.vx * ux + me.vy * uy) / sp > 0.85;
  switch (m.plan) {
    case "hunt":
      // lead the target a little
      x = dx + t.vx * 0.25;
      y = dy + t.vy * 0.25;
      dash = ready && dist < 3.5 + m.p.dashy * 2 && lined && Math.random() < 0.05 + m.p.dashy * 0.1;
      break;
    case "flank": {
      // get on the safe side of the target, then shove it towards the drop (the rim, or the hole in battle)
      const sgn = hole === null ? 1 : -1;
      const ox = (tr > 0.01 ? t.x / tr : 1) * sgn;
      const oy = (tr > 0.01 ? t.y / tr : 0) * sgn;
      const sx = t.x - ox * 2.2;
      const sy = t.y - oy * 2.2;
      if (d({ x: sx, y: sy }, me) > 1.2 && dist > 1.6) [x, y] = [sx - me.x, sy - me.y];
      else {
        [x, y] = [ox, oy];
        dash = ready && Math.random() < 0.08 + m.p.dashy * 0.12;
      }
      break;
    }
    case "circle": {
      // orbit at a distance, then lunge when they wander near the rim
      const want = 4.5;
      const tx = -uy * m.side;
      const ty = ux * m.side;
      const pull = (dist - want) * 0.5;
      x = tx + ux * pull;
      y = ty + uy * pull;
      if (tEdge > 0.6 - m.p.aggro * 0.15 || Math.random() < 0.004) {
        m.plan = "hunt";
        m.until = sim.tick + 90;
      }
      break;
    }
    case "juke": {
      // run straight in, sidestep at the last moment, then dash into their side
      if (dist > 3.2) [x, y] = [dx, dy];
      else if (dist > 1.8) [x, y] = [ux * 0.4 - uy * m.side, uy * 0.4 + ux * m.side];
      else {
        [x, y] = [dx, dy];
        dash = ready && Math.random() < 0.3;
      }
      break;
    }
    case "bait": {
      // sit near the middle and punish whoever comes close
      const hs = hole === null ? 0.4 : 1;
      const hx = m.spot.x * hs - me.x;
      const hy = m.spot.y * hs - me.y;
      const hl = Math.hypot(hx, hy);
      x = hl > 0.8 ? hx : -uy * m.side * 0.3;
      y = hl > 0.8 ? hy : ux * m.side * 0.3;
      if (dist < 3.2) {
        [x, y] = [dx, dy];
        dash = ready && Math.random() < 0.15 + m.p.dashy * 0.2;
      }
      break;
    }
    case "wander":
      [x, y] = [m.spot.x - me.x, m.spot.y - me.y];
      if (Math.hypot(x, y) < 1) m.until = Math.min(m.until, sim.tick + 20);
      if (dist < 2.5) [x, y] = [dx, dy];
      break;
    case "vulture": {
      // hang back from a fight between others, then pounce on whoever's losing
      const fight = foes.find((o) => o.seat !== t.seat && d(o, t) < 3.5);
      if (fight && dist > 6) [x, y] = [dx * 0.5 - uy * m.side * 3, dy * 0.5 + ux * m.side * 3];
      else if (fight) [x, y] = [-ux + -uy * m.side, -uy + ux * m.side];
      else {
        m.plan = tEdge > 0.55 ? "flank" : "hunt";
        m.until = sim.tick + 120;
      }
      if (fight && tEdge > 0.65 && dist < 7) {
        m.plan = "flank";
        m.until = sim.tick + 120;
      }
      break;
    }
  }
  // dodge an incoming dash now and then (cautious bots react more)
  if (sim.tick < m.dodgeUntil) [x, y] = [m.dodge.x, m.dodge.y];
  else
    for (const o of foes) {
      const od = d(o, me);
      if (od > 4 || !dashing(o, sim.tick)) continue;
      const ov = Math.hypot(o.vx, o.vy) || 1;
      const toward = (o.vx * (me.x - o.x) + o.vy * (me.y - o.y)) / (ov * od);
      if (toward > 0.8 && Math.random() < 0.08 + m.p.caution * 0.12) {
        // step sideways, away from the drop
        const px = -o.vy / ov;
        const py = o.vx / ov;
        const s = (px * -me.x + py * -me.y > 0 ? 1 : -1) * (hole === null ? 1 : -1);
        m.dodge = { x: px * s, y: py * s };
        m.dodgeUntil = sim.tick + 18;
        dash = ready && Math.random() < m.p.dashy * 0.5;
        [x, y] = [m.dodge.x, m.dodge.y];
        break;
      }
    }
  // a wavering line, so the approach isn't a laser
  const l = Math.hypot(x, y) || 1;
  const w = Math.sin(sim.tick / 60 * m.p.freq * Math.PI * 2 + m.p.phase) * m.p.wobble;
  const nx = x / l;
  const ny = y / l;
  return { x: nx - ny * w, y: ny + nx * w, dash, target: t, plan: m.plan, m };
}
