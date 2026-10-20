// Free browser demo: the same physics and renderer as the online game, run
// locally against bots or a friend on the same keyboard. No wallet, no server.
import { createSim, step, setInput, botInput, snapshot, TICK_HZ, DT, type Sim, type Input } from "../shared/physics";
import { COLORS } from "../shared/config";
import { ArenaView } from "../web/src/render";
import { createControls } from "../web/src/input";

type Mode = "bots" | "duo";
type Level = "easy" | "normal" | "hard";
const LEVELS: Record<Level, number> = { easy: 0.55, normal: 0.75, hard: 0.95 };

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const view = new ArenaView($<HTMLCanvasElement>("#arena"), 18);
view.start();
const readTouch = createControls($("#stage"));

let mode: Mode = "bots";
let level: Level = "normal";
let sim: Sim | null = null;
let humans: number[] = [];
let raf = 0;
let countdownUntil = 0;
const names = (seat: number) => (mode === "duo" ? (seat === 0 ? "Player 1" : seat === 1 ? "Player 2" : `Bot ${seat + 1}`) : seat === 0 ? "You" : `Bot ${seat + 1}`);

// local stats (per browser only)
const stats = load();
function load(): { wins: number; played: number; streak: number; best: number } {
  try {
    return { wins: 0, played: 0, streak: 0, best: 0, ...JSON.parse(localStorage.getItem("bb.demo.stats") || "{}") };
  } catch {
    return { wins: 0, played: 0, streak: 0, best: 0 };
  }
}
function save() {
  try {
    localStorage.setItem("bb.demo.stats", JSON.stringify(stats));
  } catch {}
}
function renderStats() {
  $("#stat-wins").textContent = String(stats.wins);
  $("#stat-played").textContent = String(stats.played);
  $("#stat-streak").textContent = String(stats.streak);
  $("#stat-best").textContent = String(stats.best);
}

// two-player keyboard split: WASD + Space, arrows + Enter
const keys = new Set<string>();
const dashQueued = [false, false];
addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (e.code === "Space") dashQueued[0] = true;
  if (e.code === "Enter" || e.code === "ShiftRight") dashQueued[1] = true;
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code) && sim) e.preventDefault();
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());

function keyInput(p: 0 | 1): Input {
  const [u, d, l, r] = p === 0 ? ["KeyW", "KeyS", "KeyA", "KeyD"] : ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  let x = (keys.has(r) ? 1 : 0) - (keys.has(l) ? 1 : 0);
  let y = (keys.has(d) ? 1 : 0) - (keys.has(u) ? 1 : 0);
  const len = Math.hypot(x, y);
  if (len > 1) (x /= len), (y /= len);
  const dash = dashQueued[p];
  dashQueued[p] = false;
  return { x, y, dash };
}

function seatsHtml() {
  if (!sim) return "";
  return sim.balls
    .map(
      (b, i) =>
        `<li class="${b.alive ? "" : "out"} ${humans.includes(i) ? "human" : ""}"><span class="swatch" style="--c:${COLORS[i]}"></span>${names(i)}${b.alive ? "" : '<span class="ko">OUT</span>'}</li>`,
    )
    .join("");
}

function toast(text: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 2200);
}

function start() {
  cancelAnimationFrame(raf);
  sim = createSim(4);
  humans = mode === "duo" ? [0, 1] : [0];
  view.setPlayers(4, mode === "duo" ? null : 0);
  view.pushSnapshot(snapshot(sim));
  $("#menu").hidden = true;
  $("#result").hidden = true;
  $("#hud").hidden = false;
  $("#hint").textContent = mode === "duo" ? "P1: WASD + Space · P2: Arrows + Enter" : "WASD or arrows to roll · Space to dash";
  $("#seats").innerHTML = seatsHtml();
  countdownUntil = performance.now() + 3000;
  let acc = 0;
  let last = performance.now();
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const left = Math.ceil((countdownUntil - now) / 1000);
    $("#count").hidden = left <= 0;
    if (left > 0) {
      $("#count").textContent = String(left);
      last = now;
      return;
    }
    acc += Math.min(0.1, (now - last) / 1000);
    last = now;
    while (acc >= DT && sim && !sim.over) {
      acc -= DT;
      if (mode === "duo") {
        setInput(sim, 0, keyInput(0));
        setInput(sim, 1, keyInput(1));
      } else {
        const k1 = keyInput(0);
        const k2 = keyInput(1);
        const t = readTouch();
        let x = k1.x + k2.x + t.x;
        let y = k1.y + k2.y + t.y;
        const len = Math.hypot(x, y);
        if (len > 1) (x /= len), (y /= len);
        setInput(sim, 0, { x, y, dash: k1.dash || k2.dash || t.dash });
      }
      for (let i = 0; i < 4; i++) if (!humans.includes(i)) setInput(sim, i, botInput(sim, i, LEVELS[level]));
      step(sim);
      for (const e of sim.events) {
        if (e.t === "bump") view.bump(e.a, e.b, e.force);
        if (e.t === "out") {
          toast(mode === "bots" && e.seat === 0 ? "You fell off!" : `${names(e.seat)} fell off`);
          $("#seats").innerHTML = seatsHtml();
        }
      }
      view.pushSnapshot(snapshot(sim));
    }
    $("#timer").textContent = `${Math.floor(sim!.tick / TICK_HZ)}s`;
    if (mode === "bots") {
      const d = sim!.balls[0].dashReadyAt - sim!.tick;
      $("#dash").style.setProperty("--p", String(Math.max(0, 1 - d / 150)));
    }
    if (sim!.over) {
      cancelAnimationFrame(raf);
      setTimeout(finish, 900);
    }
  };
  raf = requestAnimationFrame(loop);
}

function finish() {
  if (!sim) return;
  const w = sim.winnerSeat;
  let title = w === null ? "No winner" : `${names(w)} ${mode === "bots" && w === 0 ? "win!" : "wins"}`;
  if (mode === "bots") {
    stats.played++;
    if (w === 0) {
      stats.wins++;
      stats.streak++;
      stats.best = Math.max(stats.best, stats.streak);
    } else stats.streak = 0;
    save();
    renderStats();
    if (w === 0) title = "You win!";
  }
  const secs = Math.round(sim.tick / TICK_HZ);
  $("#result-title").textContent = title;
  $("#result-title").style.setProperty("--c", w === null ? "var(--muted)" : COLORS[w]);
  $("#result-sub").textContent =
    mode === "bots"
      ? w === 0
        ? `Last ball standing after ${secs}s on ${level}. Streak: ${stats.streak}.`
        : `Knocked out on ${level}. Lasted the round's ${secs}s. Streak reset.`
      : `Round took ${secs}s.`;
  $("#result").hidden = false;
  $("#again").focus();
}

function toMenu() {
  cancelAnimationFrame(raf);
  sim = null;
  $("#result").hidden = true;
  $("#hud").hidden = true;
  $("#count").hidden = true;
  $("#menu").hidden = false;
  // idle attract loop: bots play in the background
  attract();
}

function attract() {
  const s = createSim(4);
  view.setPlayers(4, null);
  let last = performance.now();
  let acc = 0;
  const loop = (now: number) => {
    if ($("#menu").hidden) return;
    raf = requestAnimationFrame(loop);
    acc += Math.min(0.1, (now - last) / 1000);
    last = now;
    while (acc >= DT) {
      acc -= DT;
      for (let i = 0; i < 4; i++) setInput(s, i, botInput(s, i, 0.7));
      step(s);
      for (const e of s.events) if (e.t === "bump") view.bump(e.a, e.b, e.force * 0.4);
      view.pushSnapshot(snapshot(s));
      if (s.over) {
        cancelAnimationFrame(raf);
        setTimeout(() => !$("#menu").hidden && attract(), 1200);
        return;
      }
    }
  };
  raf = requestAnimationFrame(loop);
}

document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
  b.addEventListener("click", () => {
    mode = b.dataset.mode as Mode;
    document.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }),
);
document.querySelectorAll<HTMLButtonElement>("[data-level]").forEach((b) =>
  b.addEventListener("click", () => {
    level = b.dataset.level as Level;
    document.querySelectorAll("[data-level]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }),
);
$("#play").addEventListener("click", start);
$("#again").addEventListener("click", start);
$("#menu-btn").addEventListener("click", toMenu);
$("#quit").addEventListener("click", toMenu);
addEventListener("keydown", (e) => {
  if (e.code === "Enter" && !$("#result").hidden) start();
  if (e.code === "Escape" && sim) toMenu();
});
renderStats();
toMenu();
