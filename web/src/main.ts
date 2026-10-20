import "./style.css";
import { defineChain, formatEther, getAddress, zeroAddress, type Address, type Chain, type EIP1193Provider, type Hex } from "viem";
import { bumperBallsAbi } from "../../shared/abi";
import { COLORS, type Tier } from "../../shared/config";
import { SNAP_STRIDE } from "../../shared/physics";
import { MatchStatus } from "../../shared/eip712";
import { discoverWallets, walletOptions, ensureChain, clients } from "./wallet";
import { ArenaView } from "./render";
import { createControls } from "./input";

type Config = {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  contract: Address;
  walletConnectProjectId: string | null;
  tiers: Tier[];
  paid: { state: "checking" | "needs-funds" | "deploying" | "live" | "error"; deployer?: Address; balance?: string; message?: string };
};

type RoomState = {
  mode: "paid" | "practice" | "friends";
  code?: string;
  names: string[];
  host: number | null;
  round: number;
  matchId: string;
  tierId?: string;
  entryFee?: string;
  maxPlayers: number;
  joinDeadline?: number;
  phase: "waiting" | "countdown" | "playing" | "over" | "expired";
  seats: (string | null)[];
  bots: number[];
  startsAt: number;
  result: { winnerSeat: number | null; winner: Address; sig: Hex | null } | null;
  you: number | null;
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei: bigint | string) => {
  const s = formatEther(BigInt(wei));
  return `${Number(s) < 0.0001 && Number(s) > 0 ? s : Number(Number(s).toFixed(5))} ETH`;
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let cfg: Config;
let chain: Chain;
let provider: EIP1193Provider | null = null;
let account: Address | null = null;
let ws: WebSocket | null = null;
let room: RoomState | null = null;
let view: ArenaView;
let readControls: ReturnType<typeof createControls>;
let inputTimer: ReturnType<typeof setInterval> | null = null;

// ------------------------------------------------------------------ helpers

function toast(msg: string, kind: "info" | "error" | "ok" = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 4000);
}

function errMsg(e: any): string {
  const raw = e?.shortMessage || e?.message || String(e);
  if (/User rejected|denied/i.test(raw)) return "You cancelled the request in your wallet.";
  if (/insufficient funds/i.test(raw)) return "Not enough ETH in your wallet for this.";
  return raw.split("\n")[0];
}

function store<T>(key: string, value?: T): T | null {
  try {
    if (value !== undefined) localStorage.setItem(key, JSON.stringify(value));
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function myMatches(): string[] {
  return account ? store<string[]>(`bb.matches.${account}`) ?? [] : [];
}
function rememberMatch(id: string) {
  if (!account) return;
  const list = [id, ...myMatches().filter((m) => m !== id)].slice(0, 20);
  store(`bb.matches.${account}`, list);
}

function txLink(hash: string) {
  return cfg.explorer ? `${cfg.explorer}/tx/${hash}` : "#";
}

// ------------------------------------------------------------------- wallet

function renderWallet() {
  const btn = $("#wallet-btn");
  btn.textContent = account ? short(account) : "Connect wallet";
  btn.classList.toggle("connected", !!account);
  $("#net").textContent = cfg.chainName ?? `Chain ${cfg.chainId}`;
}

function openWalletPicker() {
  if (account) {
    if (confirm("Disconnect this wallet?")) {
      account = null;
      provider = null;
      renderWallet();
      renderHome();
    }
    return;
  }
  const opts = walletOptions(cfg.walletConnectProjectId, chain);
  const list = $("#wallet-list");
  list.innerHTML = "";
  if (!opts.length) {
    list.innerHTML = `<p class="muted">No wallet found in this browser. Open this page in <b>Robinhood Wallet</b>'s built-in browser, or install a browser wallet.</p>`;
  }
  for (const o of opts) {
    const b = document.createElement("button");
    b.className = "wallet-opt";
    b.innerHTML = `${o.icon ? `<img src="${esc(o.icon)}" alt="">` : `<span class="dot"></span>`}<span>${esc(o.name)}</span>`;
    b.onclick = async () => {
      $<HTMLDialogElement>("#wallet-dialog").close();
      try {
        const p = await o.connect();
        const [a] = (await p.request({ method: "eth_requestAccounts" })) as Address[];
        await ensureChain(p, chain);
        provider = p;
        account = getAddress(a);
        (p as any).on?.("accountsChanged", (accs: string[]) => {
          account = accs[0] ? getAddress(accs[0]) : null;
          renderWallet();
          renderHome();
        });
        renderWallet();
        renderHome();
        toast(`Connected ${short(account)}`, "ok");
      } catch (e) {
        toast(errMsg(e), "error");
      }
    };
    list.append(b);
  }
  $<HTMLDialogElement>("#wallet-dialog").showModal();
}

async function requireWallet(): Promise<{ provider: EIP1193Provider; account: Address }> {
  if (!provider || !account) {
    openWalletPicker();
    throw new Error("Connect a wallet first.");
  }
  await ensureChain(provider, chain);
  return { provider, account };
}

async function session(): Promise<string> {
  const { provider: p, account: a } = await requireWallet();
  const saved = store<{ token: string; exp: number }>(`bb.session.${a}`);
  if (saved && saved.exp > Date.now() / 1000 + 60) return saved.token;
  const issued = new Date().toISOString();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const message = `${location.host} wants you to sign in to Bumper Balls.\n\nThis only proves you own this wallet. It costs nothing and moves no funds.\n\nAddress: ${a}\nChain ID: ${cfg.chainId}\nIssued: ${issued}\nNonce: ${nonce}`;
  const { wallet } = clients(p, a, chain);
  const signature = await wallet.signMessage({ account: a, message });
  const r = await fetch("/api/login", { method: "POST", body: JSON.stringify({ address: a, issued, nonce, signature }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Sign-in failed");
  store(`bb.session.${a}`, { token: j.token, exp: Number(j.token.split(".")[1]) });
  return j.token;
}

// --------------------------------------------------------------------- home

async function renderHome() {
  $("#home").hidden = false;
  $("#match").hidden = true;
  const tiers = $("#tiers");
  tiers.innerHTML = "";
  for (const t of cfg.tiers) {
    const pot = BigInt(t.entryFeeWei) * BigInt(t.maxPlayers);
    const prize = (pot * 95n) / 100n;
    const card = document.createElement("button");
    card.className = "tier";
    card.innerHTML = `
      <div class="tier-top"><span class="tier-name">${esc(t.label)}</span><span class="pill">${t.maxPlayers} players</span></div>
      <div class="tier-prize">${eth(prize)}</div>
      <div class="muted">to the winner · entry ${eth(t.entryFeeWei)}</div>`;
    card.onclick = () => joinPaid(t);
    card.disabled = cfg.paid?.state !== "live";
    tiers.append(card);
  }
  const note = $("#paid-note");
  note.hidden = cfg.paid?.state === "live";
  if (cfg.paid?.state === "needs-funds")
    note.innerHTML = `Paid matches open once the game's escrow is set up. It needs a little ETH on ${esc(cfg.chainName ?? "the chain")} sent to <span class="mono">${esc(cfg.paid.deployer ?? "")}</span> (it has ${esc(cfg.paid.balance ?? "0")} now).`;
  else if (cfg.paid?.state === "deploying") note.textContent = "Setting up the escrow contract. Paid matches open in a minute.";
  else note.textContent = "Paid matches aren't open right now. Free play works.";
  await renderMine();
}

async function renderMine() {
  const box = $("#mine");
  if (!account || !provider) {
    box.innerHTML = `<p class="muted">Connect a wallet to see your matches and winnings.</p>`;
    return;
  }
  const { pub } = clients(provider, account, chain);
  box.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const bal = (await pub.readContract({ address: cfg.contract, abi: bumperBallsAbi, functionName: "balances", args: [account] })) as bigint;
    const rows: string[] = [];
    if (bal > 0n) rows.push(`<div class="row"><span>Ready to withdraw: <b>${eth(bal)}</b></span><button class="btn small" data-act="withdraw">Withdraw</button></div>`);
    const now = Date.now() / 1000;
    for (const id of myMatches()) {
      const m = (await pub.readContract({ address: cfg.contract, abi: bumperBallsAbi, functionName: "getMatch", args: [id as Hex] })) as any;
      const players = (m.players as Address[]).slice(0, Number(m.playerCount));
      const mine = players.includes(account);
      const refunded = mine
        ? ((await pub.readContract({ address: cfg.contract, abi: bumperBallsAbi, functionName: "refunded", args: [id as Hex, account] })) as boolean)
        : true;
      let label = "";
      let action = "";
      const st = Number(m.status);
      if (st === MatchStatus.None || (!mine && st !== MatchStatus.Settled)) continue;
      if (st === MatchStatus.Open && now >= Number(m.joinDeadline)) {
        label = "Didn't fill";
        action = `<button class="btn small" data-act="refund" data-id="${id}">Refund ${eth(m.entryFee)}</button>`;
      } else if (st === MatchStatus.Open) {
        label = `Waiting for players (${players.length}/${m.maxPlayers})`;
        action = `<button class="btn small ghost" data-act="open" data-id="${id}">Open</button><button class="btn small ghost" data-act="leave" data-id="${id}">Leave</button>`;
      } else if (st === MatchStatus.Full && now > Number(m.settleDeadline)) {
        label = "Never settled";
        action = `<button class="btn small" data-act="refund" data-id="${id}">Refund ${eth(m.entryFee)}</button>`;
      } else if (st === MatchStatus.Full) {
        label = "In play";
        action = `<button class="btn small ghost" data-act="open" data-id="${id}">Watch / claim</button>`;
      } else if (st === MatchStatus.Settled) {
        label = m.winner === account ? "🏆 You won" : "Lost";
      } else if (st === MatchStatus.Cancelled) {
        label = refunded ? "Refunded" : "Cancelled";
        if (!refunded) action = `<button class="btn small" data-act="refund" data-id="${id}">Refund ${eth(m.entryFee)}</button>`;
      }
      rows.push(`<div class="row"><span><span class="mono">${short(id)}</span> · ${eth(m.entryFee)} · ${label}</span><span class="acts">${action}</span></div>`);
    }
    box.innerHTML = rows.length ? rows.join("") : `<p class="muted">No matches yet.</p>`;
    box.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => {
      b.onclick = () => contractAction(b.dataset.act!, b.dataset.id as Hex | undefined);
    });
  } catch (e) {
    box.innerHTML = `<p class="muted">Couldn't read the contract: ${esc(errMsg(e))}</p>`;
  }
}

async function contractAction(act: string, id?: Hex) {
  if (act === "open" && id) return openRoom(id);
  try {
    const { provider: p, account: a } = await requireWallet();
    const { wallet, pub } = clients(p, a, chain);
    const args: any = act === "withdraw" ? [] : [id];
    const fn = act as "withdraw" | "refund" | "leave";
    const { request } = await pub.simulateContract({ account: a, address: cfg.contract, abi: bumperBallsAbi, functionName: fn, args });
    const hash = await wallet.writeContract(request);
    toast("Transaction sent…");
    await pub.waitForTransactionReceipt({ hash });
    toast(act === "leave" ? "Left the match. Your entry fee is back." : "Done. The ETH is back in your wallet.", "ok");
  } catch (e) {
    toast(errMsg(e), "error");
  }
  renderMine();
}

function confirmRealMoney(): Promise<boolean> {
  const d = $<HTMLDialogElement>("#money-dialog");
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener("close", () => resolve(d.returnValue === "yes"), { once: true });
  });
}

// -------------------------------------------------------------------- match

async function joinPaid(tier: Tier, stale?: string): Promise<void> {
  if (cfg.chainId === 4663 && !stale && !store<boolean>("bb.agreed")) {
    const ok = await confirmRealMoney();
    if (!ok) return;
    store("bb.agreed", true);
  }
  try {
    const token = await session();
    const { provider: p, account: a } = await requireWallet();
    const r = await fetch("/api/queue", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ tierId: tier.id, stale }),
    });
    const t = await r.json();
    if (!r.ok) throw new Error(t.error);
    const { wallet, pub } = clients(p, a, chain);
    const m = (await pub.readContract({ address: cfg.contract, abi: bumperBallsAbi, functionName: "getMatch", args: [t.matchId] })) as any;
    const already = (m.players as string[]).slice(0, Number(m.playerCount)).includes(a);
    if (!already) {
      let request;
      try {
        ({ request } = await pub.simulateContract({
          account: a,
          address: cfg.contract,
          abi: bumperBallsAbi,
          functionName: "join",
          args: [t.matchId, t.maxPlayers, BigInt(t.joinDeadline), BigInt(t.ticketExpiry), t.sig],
          value: BigInt(t.entryFee),
        }));
      } catch (e: any) {
        if (!stale && /MatchNotOpen|JoinClosed/.test(String(e?.message))) return joinPaid(tier, t.matchId); // seats just filled, get the next match
        throw e;
      }
      openRoom(t.matchId);
      setStatus(`Confirm the ${eth(t.entryFee)} entry in your wallet…`);
      const hash = await wallet.writeContract(request);
      rememberMatch(t.matchId);
      setStatus(`Paying entry… <a href="${txLink(hash)}" target="_blank" rel="noopener">view transaction</a>`);
      await pub.waitForTransactionReceipt({ hash });
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "poke" }));
      toast("You're in. Waiting for the other players.", "ok");
    } else {
      openRoom(t.matchId);
    }
  } catch (e) {
    toast(errMsg(e), "error");
    if (room?.phase === "waiting" && room.you === null) setStatus("");
  }
}

async function joinPractice() {
  const r = await fetch("/api/practice", { method: "POST" });
  const { roomId } = await r.json();
  openRoom(roomId);
}

async function createFriends() {
  const r = await fetch("/api/friends", { method: "POST" });
  const { roomId } = await r.json();
  openRoom(roomId);
}

function nickname() {
  const v = $<HTMLInputElement>("#nick").value.trim().slice(0, 16);
  store("bb.nick", v);
  return v;
}

function openRoom(id: string) {
  ws?.close();
  room = null;
  $("#home").hidden = true;
  $("#match").hidden = false;
  $("#result").hidden = true;
  setStatus("Connecting…");
  view.setPlayers(0, null);
  const token = account ? store<{ token: string }>(`bb.session.${account}`)?.token ?? "" : "";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws/${id}?token=${encodeURIComponent(token)}&name=${encodeURIComponent(nickname())}`);
  ws = sock;
  sock.onmessage = (e) => onRoomMessage(JSON.parse(e.data));
  sock.onclose = (e) => {
    if (ws !== sock) return;
    if (e.code === 4000) setStatus("This match is open in another tab.");
    else if (!room) setStatus(id.startsWith("friends-") ? "No room with that code. Check it and try again." : "That match isn't available any more.");
    else if (room?.phase !== "over" && room?.phase !== "expired") {
      setStatus("Connection lost. Reconnecting…");
      setTimeout(() => ws === sock && openRoom(id), 1500);
    }
  };
  history.replaceState(null, "", `#${id}`);
  if (inputTimer) clearInterval(inputTimer);
  let lastSent = "";
  inputTimer = setInterval(() => {
    if (!room || room.phase !== "playing" || room.you === null || ws?.readyState !== WebSocket.OPEN) return;
    const c = readControls();
    const msg = JSON.stringify({ t: "in", x: +c.x.toFixed(3), y: +c.y.toFixed(3), dash: c.dash });
    if (msg !== lastSent || c.dash) ws.send(msg);
    lastSent = msg;
    const d = view.dashReadyIn(room.you);
    $("#dash-meter").style.setProperty("--p", String(Math.max(0, 1 - d / 150)));
  }, 1000 / 30);
}

function leaveRoom() {
  ws?.close();
  ws = null;
  room = null;
  if (inputTimer) clearInterval(inputTimer);
  history.replaceState(null, "", location.pathname);
  renderHome();
}

function onRoomMessage(msg: any) {
  switch (msg.t) {
    case "hello":
    case "seats": {
      room = msg as RoomState;
      // the server sends time left, not its clock: count down on our own clock
      room.startsAt = msg.phase === "countdown" ? Date.now() + Number(msg.startsIn || 0) : 0;
      const n = playerCount(room);
      const inRound = room.phase === "playing" || room.phase === "countdown" || room.phase === "over";
      if (view.players !== n && !(room.mode === "friends" && inRound)) view.setPlayers(n, room.you);
      view.you = room.you;
      renderSeats();
      renderPhase();
      if (room.result && room.phase === "over") showResult();
      break;
    }
    case "start":
      setStatus("");
      $("#result").hidden = true;
      resetView = true;
      break;
    case "s": {
      const n = Math.floor((msg.d.length - 2) / SNAP_STRIDE);
      if (resetView || view.players !== n) view.setPlayers(n, room?.you ?? null);
      resetView = false;
      view.pushSnapshot(msg.d);
      break;
    }
    case "ev":
      for (const e of msg.e) {
        if (e.t === "bump") view.bump(e.a, e.b, e.force);
        if (e.t === "out" && room) {
          const name = seatName(e.seat);
          toast(e.seat === room.you ? "You fell off!" : `${name} fell off`);
        }
      }
      break;
    case "over":
      if (room) {
        room.result = msg;
        room.phase = "over";
        setTimeout(showResult, 900);
      }
      break;
  }
}

let resetView = false;
function playerCount(r: RoomState) {
  if (r.mode === "practice") return r.maxPlayers;
  if (r.mode === "friends") return r.seats.filter((s) => s !== null).length || 1;
  return r.seats.length;
}

function seatName(i: number) {
  if (!room) return "";
  if (room.bots.includes(i)) return `Bot ${i + 1}`;
  const s = room.seats[i];
  const nick = room.names?.[i];
  if (i === room.you) return nick ? `${nick} (you)` : "You";
  if (!s) return room.mode === "practice" ? "Bot (joining)" : "Open seat";
  if (nick) return nick;
  if (s.startsWith("guest:")) return `Guest ${i + 1}`;
  return short(s);
}

function renderSeats() {
  if (!room) return;
  const el = $("#seats");
  const n = room.maxPlayers;
  let html = "";
  for (let i = 0; i < n; i++) {
    const filled = room.mode === "practice" ? true : room.mode === "friends" ? !!room.seats[i] || room.bots.includes(i) : i < room.seats.length;
    const tag = room.mode === "paid" ? (filled ? "paid" : "open") : "";
    html += `<div class="seat ${filled ? "" : "empty"} ${i === room.you ? "me" : ""}"><span class="ball" style="background:${filled ? COLORS[i] : "transparent"}"></span><span>${filled ? esc(seatName(i)) : "Open seat"}</span>${tag ? `<span class="tag">${tag}</span>` : ""}</div>`;
  }
  el.innerHTML = html;
  $("#pot").textContent =
    room.mode === "paid" && room.entryFee
      ? `Pot ${eth(BigInt(room.entryFee) * BigInt(room.maxPlayers))}`
      : room.mode === "friends"
        ? `Room ${room.code?.toUpperCase()} · free`
        : "Practice · free";
  const isHost = room.mode === "friends" && room.you !== null && room.you === room.host;
  $("#friends-bar").hidden = room.mode !== "friends" || room.phase === "playing" || room.phase === "countdown";
  $("#start-btn").hidden = !isHost;
  $("#bots-label").hidden = !isHost;
}

let countdownTimer: ReturnType<typeof setInterval> | null = null;
function renderPhase() {
  if (!room) return;
  if (countdownTimer) clearInterval(countdownTimer);
  $("#controls-hint").hidden = room.phase !== "countdown" && room.phase !== "playing";
  $("#dash-meter").hidden = room.phase !== "playing" || room.you === null;
  if (room.phase === "waiting") {
    if (room.mode === "paid") {
      const left = room.maxPlayers - room.seats.length;
      const mins = Math.max(0, Math.round(((room.joinDeadline ?? 0) - Date.now() / 1000) / 60));
      setStatus(
        room.you === null
          ? `Waiting for ${left} more player${left === 1 ? "" : "s"}…`
          : `You're in. Waiting for ${left} more player${left === 1 ? "" : "s"}. If it doesn't fill in ~${mins} min, you can take your entry back.`,
      );
      $("#share").hidden = false;
    } else if (room.mode === "friends") {
      const n = room.seats.filter(Boolean).length;
      setStatus(
        room.you === null
          ? "This room is full. You're watching."
          : room.you === room.host
            ? n < 2
              ? `Send your friends the code <b>${esc(room.code?.toUpperCase() ?? "")}</b> or the invite link. Press Start when everyone's in.`
              : `${n} players in. Press Start when you're ready.`
            : "You're in. Waiting for the host to press Start.",
      );
    } else setStatus("Waiting for players…");
  } else if (room.phase === "countdown") {
    $("#share").hidden = true;
    const tick = () => {
      const s = Math.ceil((room!.startsAt - Date.now()) / 1000);
      setStatus(s > 0 ? `<span class="big">${s}</span>${room!.you === null ? "Spectating" : "Get ready! Knock everyone off."}` : "");
    };
    tick();
    countdownTimer = setInterval(tick, 200);
  } else if (room.phase === "playing") {
    $("#share").hidden = true;
    setStatus("");
  } else if (room.phase === "expired") {
    setStatus(
      room.you !== null
        ? `This match didn't fill in time. <button class="btn small" id="refund-now">Refund my ${eth(room.entryFee ?? "0")}</button>`
        : "This match didn't fill in time.",
    );
    $("#refund-now")?.addEventListener("click", () => contractAction("refund", room!.matchId as Hex));
  }
}

function setStatus(html: string) {
  $("#status").innerHTML = html;
  $("#status").hidden = !html;
}

function showResult() {
  if (!room?.result) return;
  const r = room.result;
  const el = $("#result");
  el.hidden = false;
  const youWon = r.winnerSeat !== null && r.winnerSeat === room.you;
  const pot = room.entryFee ? BigInt(room.entryFee) * BigInt(room.maxPlayers) : 0n;
  let html = "";
  if (r.winnerSeat === null) {
    html = `<h2>No winner</h2><p>Nobody played, so everyone gets their entry back.</p>`;
    if (room.mode === "paid" && room.you !== null && r.sig) html += `<button class="btn" id="claim">Get my ${eth(room.entryFee!)} back</button>`;
  } else if (youWon) {
    html = `<h2>🏆 You win!</h2>`;
    if (room.mode === "paid" && r.sig) html += `<p>The pot is yours, minus the 5% fee.</p><button class="btn" id="claim">Claim ${eth((pot * 95n) / 100n)}</button>`;
  } else {
    html = `<h2>${esc(seatName(r.winnerSeat))} wins</h2>`;
    if (room.mode === "paid") html += `<p class="muted">Better luck next round.</p>`;
  }
  const isHost = room.mode === "friends" && room.you === room.host;
  if (room.mode === "friends" && !isHost) html += `<p class="muted">Waiting for the host to start the next round.</p>`;
  html += `<div class="acts">${isHost ? `<button class="btn" id="rematch">Play again</button>` : ""}<button class="btn ghost" id="again">${room.mode === "practice" ? "Play again" : "Back to lobby"}</button></div>`;
  el.innerHTML = html;
  $("#again").onclick = () => (room?.mode === "practice" ? joinPractice() : leaveRoom());
  $("#rematch")?.addEventListener("click", beginFriends);
  $("#claim")?.addEventListener("click", claim);
}

async function claim() {
  if (!room?.result?.sig) return;
  try {
    const { provider: p, account: a } = await requireWallet();
    const { wallet, pub } = clients(p, a, chain);
    const { request } = await pub.simulateContract({
      account: a,
      address: cfg.contract,
      abi: bumperBallsAbi,
      functionName: "claim",
      args: [room.matchId as Hex, room.result.winner ?? zeroAddress, room.result.sig],
    });
    const hash = await wallet.writeContract(request);
    toast("Claiming…");
    await pub.waitForTransactionReceipt({ hash });
    toast("Paid out to your wallet!", "ok");
    $("#claim")?.remove();
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

function beginFriends() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "begin", bots: $<HTMLInputElement>("#bots").checked }));
}

// --------------------------------------------------------------------- boot

async function boot() {
  cfg = await (await fetch("/api/config")).json();
  chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainName ?? `Chain ${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: cfg.explorer ? { default: { name: "Explorer", url: cfg.explorer } } : undefined,
  });
  view = new ArenaView($<HTMLCanvasElement>("#arena"));
  view.start();
  readControls = createControls($("#match"));
  discoverWallets(() => {});
  $("#wallet-btn").onclick = openWalletPicker;
  $("#practice-btn").onclick = joinPractice;
  $("#friends-btn").onclick = createFriends;
  $("#start-btn").onclick = beginFriends;
  $("#join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $<HTMLInputElement>("#join-code").value.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (code.length === 5) openRoom(`friends-${code}`);
    else toast("Room codes are 5 letters and numbers.", "error");
  });
  $<HTMLInputElement>("#nick").value = store<string>("bb.nick") ?? "";
  $("#copy-invite").onclick = async () => {
    const url = `${location.origin}/#${room?.matchId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Invite link copied", "ok");
    } catch {
      toast(url);
    }
  };
  $("#back").onclick = leaveRoom;
  $("#share").onclick = async () => {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied. Send it to a friend to fill the match.", "ok");
    } catch {
      prompt("Copy this link", url);
    }
  };
  const mainnet = cfg.chainId === 4663;
  $("#paid-title").textContent = mainnet ? "Play for ETH" : "Play for testnet ETH";
  $("#net-note").textContent = mainnet
    ? "Entries are real ETH on Robinhood Chain. You must be 18 or older, and only play where paid skill games are legal."
    : "Testnet only. Testnet ETH has no value.";
  $("#contract-link").setAttribute("href", cfg.explorer ? `${cfg.explorer}/address/${cfg.contract}` : "#");
  renderWallet();
  const hash = location.hash.slice(1);
  if (hash) openRoom(hash);
  else renderHome();
}

boot().catch((e) => {
  document.body.innerHTML = `<p style="padding:2rem">Couldn't load the game: ${esc(errMsg(e))}</p>`;
});
