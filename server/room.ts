// One room per match. Paid rooms watch the escrow until every seat is paid,
// then run the authoritative simulation and sign the result. Practice rooms
// fill empty seats with bots. Friends rooms wait for their host to press Start.
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import type { WebSocket } from "ws";
import { createSim, step, setInput, cleanInput, snapshot, botInput, TICK_HZ, type Sim } from "../shared/physics";
import { createBattleSim, stepBattle, battleSnapshot, battleBotInput } from "../shared/battle";
import { COUNTDOWN_SEC } from "../shared/config";
import { MatchStatus } from "../shared/eip712";
import { readMatch, settleMatch, signResult } from "./chain";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
import type { Env } from "./env";

export type Phase = "waiting" | "countdown" | "playing" | "over" | "expired";
export type Mode = "paid" | "practice" | "friends";
export type Variant = "classic" | "battle";

export type Config = {
  mode: Mode;
  variant?: Variant; // battle mode is free only (practice and friends rooms)
  matchId: string;
  code?: string;
  tierId?: string;
  entryFee?: string;
  maxPlayers: number;
  joinDeadline?: number;
};

type Result = { winnerSeat: number | null; winner: Address; sig: Hex | null };
type Conn = { ws: WebSocket; address: Address | null; name: string; seat: number | null; msgs: number; windowStart: number };

const PRACTICE_FILL_SEC = 5;
const MAX_MSG_BYTES = 256;
const MAX_MSGS_PER_SEC = 90;
const BOT_LEVEL = 0.75;

/** Persists what a restart must not lose: paid matches still in play. */
export interface Persist {
  activePaid(matchId: string, active: boolean): void;
  /** Count a finished match toward a signed-in player's record. */
  record(address: Address, won: boolean, prizeWei: bigint): void;
  nameOf(address: Address): string | null;
}

export class Room {
  phase: Phase = "waiting";
  lastActive = Date.now();
  private seats: (string | null)[] = []; // paid: on-chain players; others: wallet or guest id per seat
  private names: string[] = [];
  private skinBy = new Map<string, string>(); // seat id (wallet or guest) -> skin file
  private bots = new Set<number>();
  private result: Result | null = null;
  private conns = new Set<Conn>();
  private sim: Sim | null = null;
  private startsAt = 0;
  private round = 0;
  private hostSeat = 0;
  private loop: ReturnType<typeof setInterval> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private guestSeq = 0;
  private variant: Variant;

  constructor(readonly cfg: Config, private env: Env, private persist: Persist) {
    if (cfg.mode !== "paid") this.seats = Array(cfg.maxPlayers).fill(null);
    this.variant = cfg.mode === "paid" ? "classic" : cfg.variant ?? "classic";
  }

  /** A paid match whose game state was lost in a restart: call it off so everyone is refunded at once. */
  async cancelAfterRestart() {
    this.phase = "playing";
    await this.finish(null);
  }

  get joinable() {
    const now = Date.now() / 1000;
    if (this.cfg.mode === "paid") return this.phase === "waiting" && now < (this.cfg.joinDeadline ?? 0) && this.seats.length < this.cfg.maxPlayers;
    if (this.cfg.mode === "practice")
      return (this.phase === "waiting" || (this.phase === "countdown" && this.startsAt - Date.now() > 1500)) && this.seats.some((s) => s === null);
    return true; // friends rooms take spectators even when full
  }

  get idle() {
    return this.conns.size === 0 && Date.now() - this.lastActive > 10 * 60_000 && this.phase !== "playing";
  }

  // ------------------------------------------------------------ connections

  attach(ws: WebSocket, address: Address | null, name: string, skin = "") {
    this.lastActive = Date.now();
    const conn: Conn = { ws, address, name, seat: null, msgs: 0, windowStart: Date.now() };
    // one live connection per wallet: a new tab replaces the old one
    if (address) for (const c of this.conns) if (c.address === address) this.drop(c);
    this.conns.add(conn);
    if (this.cfg.mode !== "paid") this.takeSeat(conn);
    // remembered by wallet (or guest seat), so it follows the player when seats are reordered
    const skinKey = conn.seat !== null ? this.seats[conn.seat] : address;
    if (skinKey) this.skinBy.set(skinKey, skin);

    ws.on("message", (data, isBinary) => !isBinary && this.onMessage(conn, data.toString()));
    ws.on("close", () => this.detach(conn));
    ws.on("error", () => this.detach(conn));

    this.send(conn, { t: "hello", you: this.seatOf(conn), ...this.publicState() });
    if (this.cfg.mode === "paid") this.ensurePolling();
    this.broadcastSeats();
  }

  private takeSeat(conn: Conn) {
    const id = conn.address ?? `guest:${++this.guestSeq}`;
    // a returning wallet gets its old seat back
    const existing = conn.address ? this.seats.indexOf(conn.address) : -1;
    if (existing >= 0) {
      conn.seat = existing;
      this.names[existing] = conn.name;
      return;
    }
    if (this.cfg.mode === "practice" && this.phase !== "waiting" && this.phase !== "countdown") return;
    if (this.cfg.mode === "friends" && this.phase !== "waiting" && this.phase !== "over") return;
    const free = this.seats.findIndex((s) => s === null);
    if (free < 0) return;
    conn.seat = free;
    this.seats[free] = id;
    this.names[free] = conn.name;
    if (this.cfg.mode === "friends" && [...this.conns].filter((c) => c.seat !== null && c !== conn).length === 0) this.hostSeat = free;
    if (this.cfg.mode === "practice" && !this.startsAt) this.beginCountdown(PRACTICE_FILL_SEC);
  }

  private detach(conn: Conn) {
    if (!this.conns.delete(conn)) return;
    this.lastActive = Date.now();
    if (this.cfg.mode === "friends" && conn.seat !== null && (this.phase === "waiting" || this.phase === "over")) {
      // free the seat in the lobby, and hand host to the next player if the host left
      this.seats[conn.seat] = null;
      this.names[conn.seat] = "";
      if (conn.seat === this.hostSeat) {
        const next = [...this.conns].find((c) => c.seat !== null);
        if (next) this.hostSeat = next.seat!;
      }
    }
    this.broadcastSeats();
  }

  private drop(c: Conn) {
    try {
      c.ws.close(4000, "replaced by a newer connection");
    } catch {}
    this.conns.delete(c);
  }

  private seatOf(c: Conn): number | null {
    if (this.cfg.mode !== "paid") return c.seat;
    if (!c.address) return null;
    const i = this.seats.findIndex((s) => s && getAddress(s) === c.address);
    return i >= 0 ? i : null;
  }

  private onMessage(c: Conn, data: string) {
    if (data.length > MAX_MSG_BYTES) return;
    const now = Date.now();
    if (now - c.windowStart > 1000) {
      c.windowStart = now;
      c.msgs = 0;
    }
    if (++c.msgs > MAX_MSGS_PER_SEC) return;
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg?.t === "in" && this.sim && this.phase === "playing") {
      const seat = this.seatOf(c);
      if (seat !== null && !this.bots.has(seat)) setInput(this.sim, seat, cleanInput(msg));
    } else if (msg?.t === "poke" && this.cfg.mode === "paid") {
      // the player's payment just confirmed: re-read the chain, then always tell them where they stand
      this.pollChain().then(() => this.send(c, { t: "seats", you: this.seatOf(c), ...this.publicState() }));
    } else if (msg?.t === "begin" && this.cfg.mode === "friends" && this.seatOf(c) === this.hostSeat) {
      if (this.phase === "waiting" || this.phase === "over") {
        this.variant = msg.battle === true ? "battle" : "classic";
        this.resetForRound(msg.bots !== false);
      }
    } else if (msg?.t === "ping") {
      this.send(c, { t: "pong", c: msg.c });
    }
  }

  private send(c: Conn, msg: unknown) {
    try {
      c.ws.send(JSON.stringify(msg));
    } catch {
      this.conns.delete(c);
    }
  }

  private broadcast(msg: unknown) {
    const s = JSON.stringify(msg);
    for (const c of this.conns) {
      try {
        c.ws.send(s);
      } catch {
        this.conns.delete(c);
      }
    }
  }

  private broadcastSeats() {
    for (const c of this.conns) this.send(c, { t: "seats", you: this.seatOf(c), ...this.publicState() });
  }

  publicState() {
    const cfg = this.cfg;
    return {
      mode: cfg.mode,
      variant: this.variant,
      matchId: cfg.matchId,
      code: cfg.code,
      tierId: cfg.tierId,
      entryFee: cfg.entryFee,
      maxPlayers: cfg.maxPlayers,
      joinDeadline: cfg.joinDeadline,
      phase: this.phase,
      seats: this.seats,
      // a signed-in player always shows under their username
      names: this.seats.map((a, i) => (a && !a.startsWith("guest:") && this.persist.nameOf(a as Address)) || this.names[i] || ""),
      skins: this.seats.map((a) => (a && this.skinBy.get(a)) || ""),
      host: cfg.mode === "friends" ? this.hostSeat : null,
      round: this.round,
      bots: [...this.bots],
      startsAt: this.startsAt,
      // relative, so a player's clock being off doesn't shift their countdown
      startsIn: this.phase === "countdown" ? Math.max(0, this.startsAt - Date.now()) : 0,
      spectators: this.conns.size,
      result: this.result,
    };
  }

  // ------------------------------------------------------------------ chain

  private ensurePolling() {
    if (this.poller || this.phase !== "waiting") return;
    this.pollChain();
    this.poller = setInterval(() => this.pollChain(), Number(this.env.POLL_MS || 2500));
  }

  private stopPolling() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private async pollChain() {
    if (this.polling || this.phase !== "waiting") return;
    this.polling = true;
    try {
      const m = await readMatch(this.env, this.cfg.matchId as Hex);
      const changed = m.players.join() !== this.seats.join();
      this.seats = m.players;
      if (m.status === MatchStatus.Full) {
        this.stopPolling();
        this.persist.activePaid(this.cfg.matchId, true);
        this.beginCountdown(COUNTDOWN_SEC);
      } else if (m.status === MatchStatus.Cancelled || Date.now() / 1000 >= (this.cfg.joinDeadline ?? 0)) {
        this.stopPolling();
        this.phase = "expired";
        this.broadcastSeats();
      } else if (changed) {
        this.broadcastSeats();
      }
      if (this.conns.size === 0 && this.phase === "waiting") this.stopPolling(); // resumes on next connect
    } catch (e) {
      console.error("poll failed", (e as Error).message);
    } finally {
      this.polling = false;
    }
  }

  // ------------------------------------------------------------------- game

  private resetForRound(withBots: boolean) {
    // drop seats whose players have gone, then start
    const live = new Set([...this.conns].map((c) => c.seat).filter((s) => s !== null));
    this.seats = this.seats.map((s, i) => (live.has(i) ? s : null));
    this.names = this.names.map((n, i) => (live.has(i) ? n : ""));
    this.result = null;
    this.bots.clear();
    this.fillBots = withBots;
    this.beginCountdown(3);
  }
  private fillBots = true;

  private beginCountdown(sec: number) {
    this.phase = "countdown";
    this.startsAt = Date.now() + sec * 1000;
    this.broadcastSeats();
    setTimeout(() => this.start(), sec * 1000);
  }

  private start() {
    const cfg = this.cfg;
    let n = this.seats.length;
    if (cfg.mode !== "paid") {
      if (cfg.mode === "friends" && !this.fillBots) {
        // compact the humans into the first seats so the arena only has real players
        const order = this.seats.map((s, i) => i).filter((i) => this.seats[i] !== null);
        const remap = new Map(order.map((old, i) => [old, i]));
        this.seats = order.map((i) => this.seats[i]).concat(Array(cfg.maxPlayers - order.length).fill(null));
        this.names = order.map((i) => this.names[i]).concat(Array(cfg.maxPlayers - order.length).fill(""));
        for (const c of this.conns) if (c.seat !== null) c.seat = remap.get(c.seat) ?? null;
        this.hostSeat = remap.get(this.hostSeat) ?? 0;
        n = Math.max(2, order.length);
        if (order.length < 2) {
          // nobody to play against: put one bot in
          this.bots.add(1);
        }
      } else {
        this.seats.forEach((s, i) => s === null && this.bots.add(i));
        n = cfg.maxPlayers;
      }
    }
    this.round++;
    const battle = this.variant === "battle";
    this.sim = battle ? createBattleSim(n) : createSim(n);
    this.phase = "playing";
    this.broadcastSeats();
    this.broadcast({ t: "start", round: this.round });

    let ticks = 0;
    this.loop = setInterval(() => {
      const sim = this.sim!;
      for (const b of this.bots) setInput(sim, b, battle ? battleBotInput(sim, b, BOT_LEVEL) : botInput(sim, b, BOT_LEVEL));
      if (battle) stepBattle(sim);
      else step(sim);
      if (sim.events.length) this.broadcast({ t: "ev", e: sim.events });
      if (++ticks % 2 === 0 || sim.over) this.broadcast(battle ? { t: "s", d: snapshot(sim), b: battleSnapshot(sim) } : { t: "s", d: snapshot(sim) });
      if (sim.over) {
        clearInterval(this.loop!);
        this.loop = null;
        this.finish(sim.winnerSeat);
      }
    }, 1000 / TICK_HZ);
  }

  private async finish(winnerSeat: number | null) {
    const cfg = this.cfg;
    let winner: Address = zeroAddress;
    let sig: Hex | null = null;
    if (cfg.mode === "paid") {
      winner = winnerSeat === null ? zeroAddress : (this.seats[winnerSeat] as Address);
      sig = await signResult(this.env, cfg.matchId as Hex, winner);
      this.persist.activePaid(cfg.matchId, false);
      const result = sig;
      settleMatch(this.env, cfg.matchId as Hex, winner, result)
        .then((hash) => {
          if (hash) log(`settled ${cfg.matchId} in ${hash}`);
        })
        .catch((e) => log(`couldn't settle ${cfg.matchId}: ${(e as Error).message.split("\n")[0]}`));
    } else if (winnerSeat !== null && !this.bots.has(winnerSeat)) {
      const s = this.seats[winnerSeat];
      winner = (s && !s.startsWith("guest:") ? s : zeroAddress) as Address;
    }
    this.result = { winnerSeat, winner, sig };
    if (winnerSeat !== null) {
      const pot = cfg.entryFee ? BigInt(cfg.entryFee) * BigInt(cfg.maxPlayers) : 0n;
      this.seats.forEach((s, i) => {
        if (!s || s.startsWith("guest:") || this.bots.has(i)) return;
        const won = i === winnerSeat;
        this.persist.record(s as Address, won, won ? (pot * 95n) / 100n : 0n);
      });
    }
    this.phase = "over";
    this.startsAt = 0;
    this.lastActive = Date.now();
    this.broadcast({ t: "over", ...this.result });
    this.broadcastSeats();
  }
}
