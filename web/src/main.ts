import "./style.css";
import { createPublicClient, http, defineChain, formatEther, parseEther, getAddress, zeroAddress, type Address, type Chain, type EIP1193Provider, type Hex } from "viem";
import { bumperBallsAbi } from "../../shared/abi";
import { COLORS, makeTier, parseTier, type Tier, type Variant } from "../../shared/config";
import { SNAP_STRIDE } from "../../shared/physics";
import { MatchStatus } from "../../shared/eip712";
import { discoverWallets, walletOptions, ensureChain, clients } from "./wallet";
import type { PrivyApi, PrivyState } from "./privy";
import { ArenaView, WEAPON_ICON, WEAPON_NAME } from "./render";
import { createControls } from "./input";
import * as sfx from "./sound";

type Config = {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  contract: Address;
  /** Earlier contract versions; players can still withdraw anything left in them. */
  oldContracts?: Address[];
  walletConnectProjectId: string | null;
  privyAppId: string | null;
  bets: { presets: string[]; min: string; max: string };
  paid: { state: "checking" | "needs-funds" | "deploying" | "live" | "error"; deployer?: Address; balance?: string; message?: string };
};

type RoomState = {
  mode: "paid" | "practice" | "friends";
  variant?: "classic" | "battle";
  code?: string;
  names: string[];
  skins?: string[];
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
let privy: PrivyApi | null = null;
let privyState: PrivyState | null = null;
let privyProblem: string | null = null;
type Profile = { name: string | null; wins: number; losses: number; earnedWei: string };
let profile: Profile | null = null;
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
  btn.textContent = account ? (profile?.name ?? privyState?.label ?? short(account)) : privy || cfg.privyAppId ? "Sign in" : "Connect wallet";
  btn.classList.toggle("connected", !!account);
  $("#net").textContent = cfg.chainName ?? `Chain ${cfg.chainId}`;
}

function openWalletPicker() {
  if (cfg.privyAppId) {
    if (account) openAccount();
    else if (privy) privy.login();
    else toast(privyProblem ?? "Sign-in is still loading. Try again in a second.", privyProblem ? "error" : "info");
    return;
  }
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
    throw new Error(cfg.privyAppId ? "Sign in first." : "Connect a wallet first.");
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

function onPrivy(s: PrivyState) {
  const was = account;
  privyState = s;
  account = s.account;
  provider = s.provider;
  if (was !== account) profile = null;
  renderWallet();
  if (was !== account && !$("#home").hidden) renderHome();
  // an invite link opened before sign-in finished loading: try it again now that we know who this is
  const hash = location.hash.slice(1);
  if (!was && account && !room && hash.startsWith("0x") && !$("#match").hidden) openRoom(hash);
  if (!was && account && s.builtIn) refreshAccount();
  if (account && was !== account) loadProfile(true);
}

// ------------------------------------------------------------------ profile

async function loadProfile(askForName = false) {
  try {
    const token = await session();
    const r = await fetch("/api/profile", { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    profile = await r.json();
    renderProfile();
    if (askForName && !profile!.name) openNameDialog();
  } catch (e) {
    // a cancelled sign-in signature just leaves the player without a username for now
    if (!/cancelled/i.test(errMsg(e))) console.warn("profile:", e);
  }
}

function renderProfile() {
  renderWallet();
  const p = profile;
  $("#acct-name").textContent = p?.name ?? "No username yet";
  $("#acct-rename").textContent = p?.name ? "Change" : "Pick a username";
  $("#st-wins").textContent = String(p?.wins ?? 0);
  $("#st-losses").textContent = String(p?.losses ?? 0);
  const played = (p?.wins ?? 0) + (p?.losses ?? 0);
  $("#st-rate").textContent = played ? `${Math.round(((p?.wins ?? 0) / played) * 100)}%` : "–";
  $("#st-earned").textContent = Number(formatEther(BigInt(p?.earnedWei ?? "0"))).toString();
  const nick = $<HTMLInputElement>("#nick");
  if (p?.name) {
    nick.value = p.name;
    nick.disabled = true;
    nick.title = "Your username. Change it from your account.";
  } else nick.disabled = false;
}

function openNameDialog() {
  const d = $<HTMLDialogElement>("#name-dialog");
  $<HTMLInputElement>("#uname").value = profile?.name ?? (store<string>("bb.nick") ?? "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
  $("#uname-err").hidden = true;
  if (!d.open) d.showModal();
}

async function saveName(e: Event) {
  e.preventDefault();
  const err = $("#uname-err");
  try {
    const token = await session();
    const r = await fetch("/api/profile", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: $<HTMLInputElement>("#uname").value.trim() }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    profile = j;
    renderProfile();
    $<HTMLDialogElement>("#name-dialog").close();
    toast(`You're ${profile!.name} now.`, "ok");
    renderLeaders();
  } catch (x) {
    err.textContent = errMsg(x);
    err.hidden = false;
  }
}

async function renderLeaders() {
  try {
    const rows = (await (await fetch("/api/leaderboard")).json()) as { name: string; wins: number; losses: number }[];
    if (!rows.length) return;
    $("#leaders").innerHTML = `<ol class="leaders">${rows
      .map((r, i) => `<li class="${r.name === profile?.name ? "me" : ""}"><span class="rank">${i + 1}</span><span>${esc(r.name)}</span><span class="muted small">${r.wins}W · ${r.losses}L</span></li>`)
      .join("")}</ol>`;
  } catch {}
}

const GAS_ROOM = 50_000_000_000_000n; // 0.00005 ETH: far more than a Robinhood Chain transaction costs

async function balanceOf(a: Address) {
  return clients(provider!, a, chain).pub.getBalance({ address: a });
}

let lastBal: bigint | null = null;
async function refreshAccount(need?: bigint) {
  if (!account) return;
  $("#acct-label").textContent = privyState?.label ?? "Your wallet";
  renderProfile();
  $("#acct-addr").textContent = account;
  $("#acct-chain").textContent = cfg.chainName ?? `chain ${cfg.chainId}`;
  $("#acct-link").setAttribute("href", cfg.explorer ? `${cfg.explorer}/address/${account}` : "#");
  const needEl = $("#acct-need");
  needEl.hidden = !need;
  try {
    const bal = await balanceOf(account);
    if (lastBal !== null && bal > lastBal) sfx.coin(); // a deposit just landed
    lastBal = bal;
    $("#acct-bal").textContent = eth(bal);
    if (need && bal < need) needEl.textContent = `You need ${eth(need - bal)} more for that match. Send it to the address below and it shows up here in a few seconds.`;
    else needEl.hidden = true;
  } catch {
    $("#acct-bal").textContent = "…";
  }
}

function openAccount(need?: bigint) {
  refreshAccount(need);
  const d = $<HTMLDialogElement>("#account-dialog");
  if (!d.open) d.showModal();
  // keep the balance live while the panel is open, so a deposit shows up by itself
  const t = setInterval(() => (d.open || signingNow ? refreshAccount(need) : clearInterval(t)), 4000);
}

/**
 * Privy's approve window is an ordinary page element, so an open dialog (which the
 * browser always draws on top) would hide it. Step the dialogs aside while the
 * player approves, then bring them back.
 */
let signingNow = false;
async function signing<T>(fn: () => Promise<T>): Promise<T> {
  const open = cfg.privyAppId ? [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")] : [];
  signingNow = open.length > 0;
  open.forEach((d) => d.close());
  try {
    return await fn();
  } finally {
    open.forEach((d) => d.isConnected && !d.open && d.showModal());
    signingNow = false;
  }
}

async function cashOut(e: Event) {
  e.preventDefault();
  try {
    const { provider: p, account: a } = await requireWallet();
    const to = getAddress($<HTMLInputElement>("#out-to").value.trim());
    const raw = $<HTMLInputElement>("#out-amt").value.trim();
    const { wallet, pub } = clients(p, a, chain);
    let value: bigint;
    if (raw.toLowerCase() === "max") {
      const bal = await pub.getBalance({ address: a });
      const fees = await pub.estimateFeesPerGas();
      const gas = await pub.estimateGas({ account: a, to, value: 1n });
      value = bal - gas * (fees.maxFeePerGas ?? 0n) * 2n;
    } else {
      value = BigInt(Math.round(Number(raw) * 1e9)) * 1_000_000_000n;
    }
    if (!(value > 0n)) throw new Error("Enter an amount, or Max.");
    const hash = await signing(() => wallet.sendTransaction({ account: a, chain, to, value }));
    toast("Sending…");
    await pub.waitForTransactionReceipt({ hash });
    toast(`Sent ${eth(value)} to ${short(to)}`, "ok");
    refreshAccount();
  } catch (err: any) {
    toast(/invalid address|Address ".*" is invalid/i.test(String(err?.message)) ? "That isn't a valid wallet address." : errMsg(err), "error");
  }
}

// --------------------------------------------------------------------- home

async function renderHome() {
  $("#fees").hidden = true;
  renderLeaders();
  $("#home").hidden = false;
  $("#match").hidden = true;
  renderBet();
  renderOpen();
  const note = $("#paid-note");
  note.hidden = cfg.paid?.state === "live";
  if (cfg.paid?.state === "needs-funds")
    note.innerHTML = `Paid matches open once the game's escrow is set up. It needs at least 0.002 ETH on ${esc(cfg.chainName ?? "the chain")} sent to <span class="mono">${esc(cfg.paid.deployer ?? "")}</span> (it has ${esc(cfg.paid.balance ?? "0")} now). This page updates by itself once it's ready.`;
  else if (cfg.paid?.state === "deploying") note.textContent = "Setting up the escrow contract. Paid matches open in a minute.";
  else note.textContent = "Paid matches aren't open right now. Free play works.";
  await renderMine();
}

async function renderMine() {
  const box = $("#mine");
  if (!account || !provider) {
    box.innerHTML = `<p class="muted">${cfg.privyAppId ? "Sign in" : "Connect a wallet"} to see your matches and winnings.</p>`;
    return;
  }
  if (cfg.paid?.state !== "live") {
    box.innerHTML = `<p class="muted">Your paid matches and winnings show up here once paid matches open.</p>`;
    return;
  }
  const { pub } = clients(provider, account, chain);
  box.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const bal = (await pub.readContract({ address: cfg.contract, abi: bumperBallsAbi, functionName: "balances", args: [account] })) as bigint;
    const rows: string[] = [];
    if (bal > 0n) rows.push(`<div class="row"><span>Ready to withdraw: <b>${eth(bal)}</b></span><button class="btn small" data-act="withdraw">Withdraw</button></div>`);
    // anything still sitting in an earlier version of the game's contract
    for (const old of cfg.oldContracts ?? []) {
      const left = await pub.readContract({ address: old, abi: bumperBallsAbi, functionName: "balances", args: [account] }).catch(() => 0n);
      if ((left as bigint) > 0n)
        rows.push(`<div class="row"><span>Left from an earlier version of the game: <b>${eth(left as bigint)}</b></span><button class="btn small" data-act="withdraw" data-contract="${old}">Withdraw</button></div>`);
    }
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
      b.onclick = () => contractAction(b.dataset.act!, b.dataset.id as Hex | undefined, b.dataset.contract as Address | undefined);
    });
  } catch (e) {
    box.innerHTML = `<p class="muted">Couldn't read the contract: ${esc(errMsg(e))}</p>`;
  }
}

async function contractAction(act: string, id?: Hex, contract: Address = cfg.contract) {
  if (act === "open" && id) return openRoom(id);
  try {
    const { provider: p, account: a } = await requireWallet();
    const { wallet, pub } = clients(p, a, chain);
    const args: any = act === "withdraw" ? [] : [id];
    const fn = act as "withdraw" | "refund" | "leave";
    const { request } = await pub.simulateContract({ account: a, address: contract, abi: bumperBallsAbi, functionName: fn, args });
    const hash = await signing(() => wallet.writeContract(request));
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

// ------------------------------------------------------------ paid picker

// what the player last picked, remembered between visits
const bet = { variant: "classic" as Variant, size: 2, amount: "0.001", custom: false, ...(store<object>("bb.bet") ?? {}) };

/** The tier the picker describes, or a reason it isn't a valid bet. */
function pickedTier(): Tier | string {
  let wei: bigint;
  try {
    wei = parseEther(bet.amount.trim().replace(",", "."));
  } catch {
    return "Type an amount in ETH, like 0.005.";
  }
  return parseTier(makeTier(bet.variant, bet.size, wei).id, parseEther(cfg.bets.max));
}

function renderBet() {
  const seg = (id: string, value: string) =>
    $(id).querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.v === value));
  seg("#bet-mode", bet.variant);
  seg("#bet-size", String(bet.size));
  const amt = $("#bet-amt");
  if (!amt.children.length) {
    amt.innerHTML =
      cfg.bets.presets.map((p) => `<button type="button" data-v="${esc(p)}">${esc(p)}</button>`).join("") +
      `<input id="bet-custom" placeholder="Other" inputmode="decimal" autocomplete="off" aria-label="Other amount in ETH" />`;
    amt.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = () => setBet({ amount: b.dataset.v!, custom: false })));
    const input = $<HTMLInputElement>("#bet-custom");
    input.oninput = () => setBet({ amount: input.value, custom: true });
    input.onfocus = () => input.value && setBet({ amount: input.value, custom: true });
    if (bet.custom) input.value = bet.amount;
  }
  seg("#bet-amt", bet.custom ? "" : bet.amount);
  $("#bet-custom").classList.toggle("on", bet.custom);
  const t = pickedTier();
  const prize = $("#bet-prize");
  const live = cfg.paid?.state === "live";
  if (typeof t === "string") {
    prize.textContent = t;
    prize.classList.add("bad");
    $("#bet-detail").textContent = `Any amount from ${cfg.bets.min} to ${cfg.bets.max} ETH.`;
  } else {
    const pot = BigInt(t.entryFeeWei) * BigInt(t.maxPlayers);
    prize.classList.remove("bad");
    prize.textContent = `Win ${eth((pot * 95n) / 100n)}`;
    $("#bet-detail").textContent = `${t.maxPlayers} players each pay ${eth(t.entryFeeWei)}. Winner takes the pot.`;
  }
  const go = $<HTMLButtonElement>("#bet-go");
  go.disabled = !live || typeof t === "string";
  go.textContent = typeof t === "string" ? "Find a match" : `Play for ${eth(t.entryFeeWei)}`;
}

function setBet(p: Partial<typeof bet>) {
  Object.assign(bet, p);
  store("bb.bet", bet);
  renderBet();
}

type OpenMatch = { matchId: string; tierId: string; players: number; maxPlayers: number; entryFee: string; variant: Variant; names: string[] };
let openTimer: ReturnType<typeof setInterval> | null = null;
async function renderOpen() {
  if (openTimer) clearInterval(openTimer);
  openTimer = setInterval(() => ($("#home").hidden ? clearInterval(openTimer!) : renderOpen()), 10_000);
  if (cfg.paid?.state !== "live") return void ($("#open-wrap").hidden = true);
  let list: OpenMatch[] = [];
  try {
    list = await (await fetch("/api/open")).json();
  } catch {}
  $("#open-wrap").hidden = list.length === 0;
  $("#open").innerHTML = list
    .map((m, i) => {
      const who = m.names.filter(Boolean).slice(0, 3).map(esc).join(", ");
      return `<div class="row"><span><b>${eth(m.entryFee)}</b> · ${m.variant === "battle" ? "Battle" : "Classic"} · ${m.maxPlayers === 2 ? "1 vs 1" : `${m.maxPlayers} players`} · ${m.players}/${m.maxPlayers} in${who ? ` <span class="muted">(${who})</span>` : ""}</span><button class="btn small" data-i="${i}">Join</button></div>`;
    })
    .join("");
  $("#open").querySelectorAll<HTMLButtonElement>("button[data-i]").forEach((b) => {
    const m = list[Number(b.dataset.i)];
    const t = tierOf(m.tierId);
    b.onclick = () => t && joinPaid(t);
  });
}

/** The tier of a match the server already made (the server checks limits when you join). */
function tierOf(id?: string): Tier | null {
  const t = id ? parseTier(id, 10n ** 30n) : null;
  return t && typeof t !== "string" ? t : null;
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
      if (cfg.privyAppId && (await pub.getBalance({ address: a })) < BigInt(t.entryFee) + GAS_ROOM) {
        openAccount(BigInt(t.entryFee) + GAS_ROOM);
        return;
      }
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
      const hash = await signing(() => wallet.writeContract(request));
      rememberMatch(t.matchId);
      // the server may already have seen the payment by the time the wallet hands back the hash
      // (Privy's wallet can wait on its own confirmation screen), so only show this if we're not seated yet
      if (room?.you == null) setStatus(`Paying entry… <a href="${txLink(hash)}" target="_blank" rel="noopener">view transaction</a>`);
      await pub.waitForTransactionReceipt({ hash });
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "poke" }));
      renderPhase(); // never leave "Paying entry…" up once the payment is confirmed
      toast("You're in. Waiting for the other players.", "ok");
    } else {
      openRoom(t.matchId);
    }
  } catch (e) {
    toast(errMsg(e), "error");
    if (room?.phase === "waiting" && room.you === null) setStatus("");
  }
}

async function joinPractice(battle = false) {
  const r = await fetch(`/api/practice${battle ? "?battle=1" : ""}`, { method: "POST" });
  const { roomId } = await r.json();
  openRoom(roomId);
}

async function createFriends() {
  const r = await fetch("/api/friends", { method: "POST" });
  const { roomId } = await r.json();
  openRoom(roomId);
}

// ------------------------------------------------------------------ skins

type Skin = { id: string; name: string; url: string };
let skins: Skin[] = [];
let mySkin = store<string>("bb.skin") ?? "";

async function loadSkins() {
  try {
    skins = await (await fetch("/api/skins")).json();
  } catch {
    skins = [];
  }
  if (!skins.some((k) => k.id === mySkin)) mySkin = "";
  $("#skin-field").hidden = skins.length === 0;
  renderSkinButton();
}

function skinSwatch(k: Skin | null) {
  return k ? `<span class="swatch" style="background-image:url('${k.url}')"></span>` : `<span class="swatch plain"></span>`;
}

function renderSkinButton() {
  const k = skins.find((x) => x.id === mySkin) ?? null;
  $("#skin-btn").innerHTML = `${skinSwatch(k)}<span>${esc(k?.name ?? "Plain")}</span>`;
}

function openSkins() {
  const grid = $("#skin-grid");
  grid.innerHTML = [null, ...skins]
    .map((k) => `<button type="button" class="skin ${(k?.id ?? "") === mySkin ? "on" : ""}" data-id="${esc(k?.id ?? "")}">${skinSwatch(k)}<span>${esc(k?.name ?? "Plain")}</span></button>`)
    .join("");
  grid.querySelectorAll<HTMLButtonElement>(".skin").forEach((b) => {
    b.onclick = () => {
      mySkin = b.dataset.id ?? "";
      store("bb.skin", mySkin);
      renderSkinButton();
      $<HTMLDialogElement>("#skin-dialog").close();
    };
  });
  $<HTMLDialogElement>("#skin-dialog").showModal();
}

function nickname() {
  const v = $<HTMLInputElement>("#nick").value.trim().slice(0, 16);
  store("bb.nick", v);
  return v;
}

let openSeq = 0;
async function openRoom(id: string) {
  const seq = ++openSeq;
  ws?.close();
  ws = null;
  room = null;
  $("#home").hidden = true;
  $("#fees").hidden = true;
  $("#match").hidden = false;
  $("#result").hidden = true;
  (document.activeElement as HTMLElement | null)?.blur?.(); // keys go to the game, not a lobby text box
  setStatus("Connecting…");
  view.setPlayers(0, null);
  let token = account ? store<{ token: string }>(`bb.session.${account}`)?.token ?? "" : "";
  // paid matches need a signed-in session; make sure it's fresh rather than letting the server turn us away
  if (account && id.startsWith("0x")) token = await session().catch(() => token);
  if (seq !== openSeq) return; // another room was opened meanwhile
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws/${id}?token=${encodeURIComponent(token)}&name=${encodeURIComponent(nickname())}&skin=${encodeURIComponent(mySkin)}`);
  ws = sock;
  sock.onmessage = (e) => onRoomMessage(JSON.parse(e.data));
  sock.onclose = (e) => {
    if (ws !== sock) return;
    if (e.code === 4000) setStatus("This match is open in another tab.");
    else if (!room && id.startsWith("0x")) paidLinkHelp(id);
    else if (!room) setStatus(id.startsWith("friends-") ? "No room with that code. Check it and try again." : "That match isn't available any more.");
    else if (room?.phase !== "over" && room?.phase !== "expired") {
      setStatus("Connection lost. Reconnecting…");
      setTimeout(() => ws === sock && openRoom(id), 1500);
    }
  };
  history.replaceState(null, "", `#${id}`);
  if (inputTimer) clearInterval(inputTimer);
  lastSent = "";
  inputTimer = setInterval(sendInput, 1000 / 30);
}

let lastSent = "";
let localDashAt = 0;
function sendInput() {
  if (!room || room.phase !== "playing" || room.you === null || ws?.readyState !== WebSocket.OPEN) return;
  const c = readControls();
  const msg = JSON.stringify({ t: "in", x: +c.x.toFixed(3), y: +c.y.toFixed(3), dash: c.dash, ...(c.use ? { use: true } : {}) });
  if (msg !== lastSent || c.dash || c.use) ws.send(msg);
  lastSent = msg;
  const d = view.dashReadyIn(room.you);
  $("#dash-meter").style.setProperty("--p", String(Math.max(0, 1 - d / 150)));
  renderWeapon();
}

/** Battle mode: what you're holding, under the dash meter (and on the phone weapon button). */
let lastWeapon = "";
function renderWeapon() {
  const f = room?.variant === "battle" && room.you !== null && room.phase === "playing" ? view.fighter(room.you) : null;
  const slot = $("#weapon");
  const btn = $(".use-btn");
  slot.hidden = btn.hidden = $("#my-hp").hidden = !f;
  if (!f) {
    lastHp = lastWeaponId = -1;
    return;
  }
  const touch = matchMedia("(pointer: coarse)").matches;
  const key = touch ? "Tap the weapon button" : "Press E";
  const has = f.weapon >= 0;
  const left = f.on > 0 ? `${Math.ceil(f.on / 60)}s` : f.weapon === 1 || f.weapon === 5 ? `×${f.ammo}` : "";
  const html = has
    ? `<span class="ic">${WEAPON_ICON[f.weapon]}</span><b>${WEAPON_NAME[f.weapon]}</b>${left ? `<span>${left}</span>` : ""}${f.on > 0 ? "" : `<span class="key">${key}</span>`}`
    : `<span>Grab a ❓ crate for a weapon</span>`;
  if (html !== lastWeapon) {
    lastWeapon = html;
    slot.innerHTML = html;
    slot.classList.toggle("empty", !has);
    btn.classList.toggle("empty", !has);
    btn.querySelector(".use-icon")!.textContent = has ? WEAPON_ICON[f.weapon] : "❓";
    btn.querySelector(".use-ammo")!.textContent = left;
  }
  // flash the slot when a new weapon is picked up
  if (has && f.weapon !== lastWeaponId) {
    slot.classList.remove("flash");
    void slot.offsetWidth;
    slot.classList.add("flash");
  }
  lastWeaponId = has ? f.weapon : -1;
  renderHp(f.hp);
}
let lastWeaponId = -1;

/** Battle mode: your own health, at the top of the screen. */
let lastHp = -1;
function renderHp(hp: number) {
  const el = $("#my-hp");
  if (hp === lastHp) return;
  if (lastHp > hp) {
    el.classList.remove("hurt");
    void el.offsetWidth;
    el.classList.add("hurt");
  }
  lastHp = hp;
  const p = Math.max(0, Math.min(1, hp / 100));
  el.style.setProperty("--hp", String(p));
  el.style.setProperty("--hp-color", p > 0.5 ? "#4ade80" : p > 0.25 ? "#facc15" : "#ef4444");
  el.querySelector("b")!.textContent = String(hp);
}

/** Weapon pressed: send it now rather than on the next input tick. */
function useNow() {
  sendInput();
}

/** Dash pressed: send it now, and play the whoosh straight away instead of after the round trip. */
function dashNow() {
  if (!room || room.phase !== "playing" || room.you === null) return;
  if (view.dashReadyIn(room.you) === 0 && performance.now() - localDashAt > 500) {
    localDashAt = performance.now();
    sfx.dash(true);
    view.dash(room.you);
  }
  sendInput();
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
      const battle = room.variant === "battle";
      if ((view.players !== n || view.battle !== battle) && !(room.mode === "friends" && inRound)) view.setPlayers(n, room.you, battle);
      view.you = room.you;
      view.setSkins(room.skins ?? []);
      renderSeats();
      renderPhase();
      if (room.result && room.phase === "over") showResult();
      break;
    }
    case "start":
      sfx.tick(true);
      lastBeep = 0;
      setStatus("");
      $("#result").hidden = true;
      resetView = true;
      break;
    case "s": {
      const n = Math.floor((msg.d.length - 2) / SNAP_STRIDE);
      if (resetView || view.players !== n || view.battle !== !!msg.b) view.setPlayers(n, room?.you ?? null, !!msg.b);
      resetView = false;
      view.pushSnapshot(msg.d, msg.b);
      break;
    }
    case "ev":
      for (const e of msg.e) {
        if (e.t === "bump") {
          const mine = e.a === room?.you || e.b === room?.you;
          view.bump(e.a, e.b, e.force);
          if (e.da || e.db) sfx.dashHit(mine);
          else sfx.bump(e.force, mine);
        }
        if (e.t === "dash") {
          const mine = e.seat === room?.you;
          // our own dash already played when the button was pressed
          if (!mine || performance.now() - localDashAt > 600) {
            view.dash(e.seat);
            sfx.dash(mine);
          }
        }
        if (e.t === "out" && room) {
          const me = e.seat === room.you;
          const name = seatName(e.seat);
          if (e.cause === "ko") {
            view.ko(e.seat);
            sfx.pop(me);
            toast(me ? "You got knocked out!" : `${name} got knocked out`);
          } else {
            sfx.fall(me);
            toast(me ? (e.cause === "hole" ? "You fell in the hole!" : "You fell off!") : `${name} ${e.cause === "hole" ? "fell in the hole" : "fell off"}`);
          }
        }
        if (e.t === "hit") {
          view.hit(e.x, e.y, e.dmg);
          if (e.k === "hammer") sfx.whack(e.seat === room?.you);
        }
        if (e.t === "boom") {
          view.boom(e.x, e.y, e.r);
          sfx.boom();
        }
        if (e.t === "crate") sfx.pickup(e.seat === room?.you);
        if (e.t === "use") {
          const mine = e.seat === room?.you;
          if (e.w === "laser") sfx.zap(mine);
          else if (e.w !== "mine") sfx.launch(mine);
        }
      }
      break;
    case "over":
      if (room) {
        room.result = msg;
        room.phase = "over";
        setTimeout(showResult, 900);
        if (account) setTimeout(() => loadProfile(), 2500); // the new win or loss
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
    html += `<div class="seat ${filled ? "" : "empty"} ${i === room.you ? "me" : ""}"><span class="ball" style="background:${filled ? (room.skins?.[i] ? `center/cover url('/skins/${encodeURIComponent(room.skins[i])}')` : COLORS[i]) : "transparent"}"></span><span>${filled ? esc(seatName(i)) : "Open seat"}</span>${tag ? `<span class="tag">${tag}</span>` : ""}</div>`;
  }
  el.innerHTML = html;
  $("#pot").textContent =
    room.mode === "paid" && room.entryFee
      ? `${room.variant === "battle" ? "Battle · " : ""}Pot ${eth(BigInt(room.entryFee) * BigInt(room.maxPlayers))}`
      : room.mode === "friends"
        ? `Room ${room.code?.toUpperCase()} · ${room.variant === "battle" ? "battle · " : ""}free`
        : room.variant === "battle"
          ? "Battle · free"
          : "Practice · free";
  const isHost = room.mode === "friends" && room.you !== null && room.you === room.host;
  $("#friends-bar").hidden = room.mode !== "friends" || room.phase === "playing" || room.phase === "countdown";
  $("#start-btn").hidden = !isHost;
  $("#bots-label").hidden = !isHost;
  $("#battle-label").hidden = !isHost;
}

function helpCount(set?: number): number {
  try {
    if (set !== undefined) localStorage.setItem("battleHelpSeen", String(set));
    return Number(localStorage.getItem("battleHelpSeen") || 0);
  } catch {
    return 0;
  }
}

let countdownTimer: ReturnType<typeof setInterval> | null = null;
let lastBeep = 0;
function renderPhase() {
  if (!room) return;
  if (countdownTimer) clearInterval(countdownTimer);
  $("#controls-hint").hidden = room.phase !== "countdown" && room.phase !== "playing";
  $("#dash-meter").hidden = room.phase !== "playing" || room.you === null;
  const battle = room.variant === "battle";
  $("#controls-hint").textContent = battle ? "WASD / arrows to roll · Space to dash · E or Shift to use your weapon" : "WASD / arrows to roll · Space to dash";
  // battle how-to: shown through the countdown and the first seconds of play, for a player's first few battles
  const help = $("#battle-help");
  if (matchMedia("(pointer: coarse)").matches) $(".use-key").textContent = "❓";
  if (battle && room.phase === "countdown" && room.you !== null && help.hidden && helpCount() < 5) {
    help.hidden = false;
    helpCount(helpCount() + 1);
  } else if (!battle || (room.phase !== "countdown" && room.phase !== "playing")) help.hidden = true;
  else if (room.phase === "playing" && !help.hidden) setTimeout(() => (help.hidden = true), 4000);
  renderWeapon();
  if (room.phase === "waiting") {
    if (room.mode === "paid") {
      const left = room.maxPlayers - room.seats.length;
      const mins = Math.max(0, Math.round(((room.joinDeadline ?? 0) - Date.now() / 1000) / 60));
      const tier = tierOf(room.tierId);
      setStatus(
        room.you === null
          ? `Waiting for ${left} more player${left === 1 ? "" : "s"}…${tier ? ` <button class="btn small" id="link-join">Join for ${eth(tier.entryFeeWei)}</button>` : ""}`
          : `You're in. Waiting for ${left} more player${left === 1 ? "" : "s"}. If it doesn't fill in ~${mins} min, you can take your entry back.`,
      );
      $("#share").hidden = false;
      if (tier) $("#link-join")?.addEventListener("click", () => joinPaid(tier));
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
      if (s > 0 && s !== lastBeep) sfx.tick();
      lastBeep = s;
      setStatus(s > 0 ? `<span class="big">${s}</span>${room!.you === null ? "Spectating" : battle ? "Get ready! Grab crates, smash everyone, mind the hole." : "Get ready! Knock everyone off."}` : "");
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

// Someone opened a shared link to a paid match. Watching needs a signed-in
// player, so explain that and offer to join it rather than calling it gone.
async function paidLinkHelp(id: string) {
  const r = await fetch(`/api/match/${id}`).catch(() => null);
  const m = r?.ok ? ((await r.json()) as RoomState & { joinable: boolean }) : null;
  const tier = tierOf(m?.tierId);
  if (!m || !tier) return setStatus("That match isn't available any more.");
  if (!m.joinable) return setStatus(`That ${esc(tier.label)} is already full or finished. <button class="btn small" id="link-home">Find another match</button>`), linkButtons(tier);
  const signIn = cfg.privyAppId ? "Sign in" : "Connect a wallet";
  setStatus(
    account
      ? `A friend invited you to a ${esc(tier.label)}. <button class="btn small" id="link-join">Join for ${eth(tier.entryFeeWei)}</button>`
      : `A friend invited you to a ${esc(tier.label)}. ${signIn} to join it for ${eth(tier.entryFeeWei)}. <button class="btn small" id="link-signin">${signIn}</button>`,
  );
  linkButtons(tier);
}

function linkButtons(tier: Tier) {
  $("#link-home")?.addEventListener("click", leaveRoom);
  $("#link-join")?.addEventListener("click", () => joinPaid(tier));
  $("#link-signin")?.addEventListener("click", () => {
    if (account) return void openRoom(location.hash.slice(1)); // already signed in: just reconnect
    openWalletPicker();
    // once signed in, swap the button for the join button
    const t = setInterval(() => {
      if (!account) return;
      clearInterval(t);
      setStatus(`Signed in. <button class="btn small" id="link-join">Join the ${esc(tier.label)} for ${eth(tier.entryFeeWei)}</button>`);
      linkButtons(tier);
    }, 500);
    setTimeout(() => clearInterval(t), 300_000);
  });
}

// ------------------------------------------------------------- house cut

// The fee wallet is usually the owner's own browser wallet, not a Privy one, so
// this page connects it on its own without touching the player sign-in.
let feeWallet: { provider: EIP1193Provider; account: Address } | null = null;

async function openFees() {
  ws?.close();
  $("#home").hidden = true;
  $("#match").hidden = true;
  $("#fees").hidden = false;
  const actions = $("#fee-actions");
  actions.innerHTML = "";
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const read = (functionName: "feeRecipient" | "feeRecipient2" | "feeShareBps") => pub.readContract({ address: cfg.contract, abi: bumperBallsAbi, functionName });
  let wallets: { wallet: Address; percent: number; owed: bigint }[];
  try {
    const [a, b, share] = (await Promise.all([read("feeRecipient"), read("feeRecipient2"), read("feeShareBps")])) as [Address, Address, number];
    const list = a === b ? [{ wallet: a, percent: 100 }] : [{ wallet: a, percent: share / 100 }, { wallet: b, percent: 100 - share / 100 }];
    wallets = await Promise.all(list.map(async (x) => ({ ...x, owed: (await pub.readContract({ address: cfg.contract, abi: bumperBallsAbi, functionName: "balances", args: [x.wallet] })) as bigint })));
  } catch {
    $("#fee-intro").textContent = "The contract isn't set up yet.";
    $("#fee-addr").textContent = "";
    $("#fee-bal").textContent = "…";
    return;
  }
  $("#fee-intro").textContent = "The 5% from every paid match is sent straight to these wallets by the contract when the match ends. Nobody has to collect it.";
  $("#fee-addr").innerHTML = wallets.map((x) => `${x.percent}% → ${esc(short(x.wallet))}`).join("<br>");
  const stuck = wallets.filter((x) => x.owed > 0n);
  $("#fee-bal").textContent = eth(stuck.reduce((t, x) => t + x.owed, 0n));
  // only if a wallet refused the payment: its share waits in the contract until it collects it
  for (const x of stuck) {
    const box = document.createElement("div");
    box.innerHTML = `<p class="muted small">${esc(short(x.wallet))} couldn't receive ${esc(eth(x.owed))} automatically. Connect that wallet to collect it.</p>`;
    actions.append(box);
    collectUi(box, x.wallet, x.owed);
  }
}

/** Connect the given fee wallet with a browser wallet and collect what it's owed. */
function collectUi(box: HTMLElement, recipient: Address, owed: bigint) {
  if (feeWallet && feeWallet.account.toLowerCase() === recipient.toLowerCase()) {
    const p = document.createElement("div");
    p.innerHTML = owed > 0n ? `<button class="btn" id="fee-collect">Collect ${eth(owed)}</button>` : `<p class="muted">Nothing to collect yet. Fees show up here a moment after each paid match ends.</p>`;
    box.append(p);
    $("#fee-collect")?.addEventListener("click", collectFees);
    return;
  }
  const opts = walletOptions(cfg.walletConnectProjectId, chain);
  if (feeWallet) box.insertAdjacentHTML("beforeend", `<p class="note">Connected ${esc(short(feeWallet.account))}, which isn't the fee wallet. Switch to ${esc(short(recipient))} in your wallet and connect again.</p>`);
  if (!opts.length) box.insertAdjacentHTML("beforeend", `<p class="muted">No browser wallet found. Install MetaMask or Rabby, add the fee wallet to it, and reload this page.</p>`);
  for (const o of opts) {
    const b = document.createElement("button");
    b.className = "wallet-opt";
    b.innerHTML = `${o.icon ? `<img src="${esc(o.icon)}" alt="">` : `<span class="dot"></span>`}<span>Connect ${esc(o.name)}</span>`;
    b.onclick = async () => {
      try {
        const p = await o.connect();
        const [a] = (await p.request({ method: "eth_requestAccounts" })) as Address[];
        await ensureChain(p, chain);
        feeWallet = { provider: p, account: getAddress(a) };
        openFees();
      } catch (e) {
        toast(errMsg(e), "error");
      }
    };
    box.append(b);
  }
}

async function collectFees() {
  if (!feeWallet) return;
  try {
    const { wallet, pub } = clients(feeWallet.provider, feeWallet.account, chain);
    await ensureChain(feeWallet.provider, chain);
    const { request } = await pub.simulateContract({ account: feeWallet.account, address: cfg.contract, abi: bumperBallsAbi, functionName: "withdraw", args: [] });
    const hash = await signing(() => wallet.writeContract(request));
    toast("Collecting…");
    await pub.waitForTransactionReceipt({ hash });
    toast("Collected. The ETH is in the fee wallet.", "ok");
    sfx.coin();
  } catch (e) {
    toast(errMsg(e), "error");
  }
  openFees();
}

function setStatus(html: string) {
  $("#status").innerHTML = html;
  $("#status").hidden = !html;
}

let resultSound = "";
function showResult() {
  if (!room?.result) return;
  const r = room.result;
  const el = $("#result");
  el.hidden = false;
  const youWon = r.winnerSeat !== null && r.winnerSeat === room.you;
  const key = `${room.matchId}:${room.round}`;
  if (key !== resultSound && room.you !== null && r.winnerSeat !== null) {
    resultSound = key;
    youWon ? sfx.win() : sfx.lose();
  }
  const pot = room.entryFee ? BigInt(room.entryFee) * BigInt(room.maxPlayers) : 0n;
  let html = "";
  if (r.winnerSeat === null) {
    html = room.mode === "paid" ? `<h2>No winner</h2><p>Nobody played, so everyone gets their entry back.</p>` : `<h2>It's a draw</h2>`;
    if (room.mode === "paid" && room.you !== null && r.sig)
      html += `<p class="muted">Your ${eth(room.entryFee!)} is on its way back to your wallet.</p><button class="btn small ghost" id="claim">Not there in a minute? Get it now</button>`;
  } else if (youWon) {
    html = `<h2>🏆 You win!</h2>`;
    if (room.mode === "paid" && r.sig)
      html += `<p>You won ${eth((pot * 95n) / 100n)}. It's on its way to your wallet.</p><button class="btn small ghost" id="claim">Not there in a minute? Claim it now</button>`;
  } else {
    html = `<h2>${esc(seatName(r.winnerSeat))} wins</h2>`;
    if (room.mode === "paid") html += `<p class="muted">Better luck next round.</p>`;
  }
  const isHost = room.mode === "friends" && room.you === room.host;
  if (room.mode === "friends" && !isHost) html += `<p class="muted">Waiting for the host to start the next round.</p>`;
  html += `<div class="acts">${isHost ? `<button class="btn" id="rematch">Play again</button>` : ""}<button class="btn ghost" id="again">${room.mode === "practice" ? "Play again" : "Back to lobby"}</button></div>`;
  el.innerHTML = html;
  $("#again").onclick = () => (room?.mode === "practice" ? joinPractice(room.variant === "battle") : leaveRoom());
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
    const hash = await signing(() => wallet.writeContract(request));
    toast("Claiming…");
    await pub.waitForTransactionReceipt({ hash });
    toast("Paid out to your wallet!", "ok");
    sfx.coin();
    $("#claim")?.remove();
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

function beginFriends() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "begin", bots: $<HTMLInputElement>("#bots").checked, battle: $<HTMLInputElement>("#battle").checked }));
}

// --------------------------------------------------------------------- boot

async function boot() {
  cfg = await (await fetch("/api/config")).json();
  // until the escrow is live, keep checking so the bet buttons unlock without a reload
  const watchPaid = setInterval(async () => {
    if (cfg.paid?.state === "live") return clearInterval(watchPaid);
    try {
      const next = (await (await fetch("/api/config")).json()) as Config;
      const changed = JSON.stringify(next.paid) !== JSON.stringify(cfg.paid);
      cfg = { ...cfg, paid: next.paid, contract: next.contract };
      if (changed && !$("#home").hidden) renderHome();
    } catch {}
  }, 10000);
  chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainName ?? `Chain ${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: cfg.explorer ? { default: { name: "Explorer", url: cfg.explorer } } : undefined,
  });
  view = new ArenaView($<HTMLCanvasElement>("#arena"));
  view.start();
  readControls = createControls($("#match"), dashNow, useNow);
  discoverWallets(() => {});
  sfx.unlockAudio();
  const mute = $("#mute-btn");
  const showMute = () => {
    mute.textContent = sfx.isMuted() ? "🔇" : "🔊";
    mute.setAttribute("aria-label", sfx.isMuted() ? "Turn sound on" : "Turn sound off");
  };
  mute.onclick = () => {
    sfx.setMuted(!sfx.isMuted());
    showMute();
  };
  showMute();
  $("#wallet-btn").onclick = openWalletPicker;
  if (cfg.privyAppId) {
    import("./privy")
      .then((m) => m.mountPrivy(cfg.privyAppId!, chain, onPrivy))
      .then((api) => (privy = api))
      .catch((e) => {
        privyProblem = errMsg(e);
        toast(privyProblem, "error");
      });
  }
  $("#cashout-form").addEventListener("submit", cashOut);
  $("#name-form").addEventListener("submit", saveName);
  $("#uname-later").onclick = () => $<HTMLDialogElement>("#name-dialog").close();
  $("#acct-rename").onclick = openNameDialog;
  $("#out-max").onclick = () => ($<HTMLInputElement>("#out-amt").value = "max");
  $("#acct-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(account ?? "");
      toast("Address copied", "ok");
    } catch {
      prompt("Your wallet address", account ?? "");
    }
  };
  $("#sign-out").onclick = async () => {
    $<HTMLDialogElement>("#account-dialog").close();
    await privy?.logout();
    profile = null;
    renderProfile();
    account = null;
    provider = null;
    renderWallet();
    renderHome();
  };
  $("#practice-btn").onclick = () => joinPractice();
  $("#bet-mode").querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = () => setBet({ variant: b.dataset.v as Variant })));
  $("#bet-size").querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = () => setBet({ size: Number(b.dataset.v) })));
  $("#bet-go").onclick = () => {
    const t = pickedTier();
    if (typeof t !== "string") joinPaid(t);
  };
  $("#battle-btn").onclick = () => joinPractice(true);
  $("#friends-btn").onclick = createFriends;
  $("#start-btn").onclick = beginFriends;
  $("#join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $<HTMLInputElement>("#join-code").value.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (code.length === 5) openRoom(`friends-${code}`);
    else toast("Room codes are 5 letters and numbers.", "error");
  });
  $<HTMLInputElement>("#nick").value = store<string>("bb.nick") ?? "";
  $("#skin-btn").onclick = openSkins;
  loadSkins();
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
  $("#fees-back").onclick = (e) => {
    e.preventDefault();
    history.replaceState(null, "", location.pathname + location.search);
    $("#fees").hidden = true;
    renderHome();
  };
  const route = () => {
    const hash = location.hash.slice(1);
    if (hash === "fees") openFees();
    else if (hash && hash !== room?.matchId) openRoom(hash);
    else if (!hash) renderHome();
  };
  // a pasted invite link in an open tab only changes the hash
  addEventListener("hashchange", route);
  const hash = location.hash.slice(1);
  if (hash === "fees") openFees();
  else if (hash) openRoom(hash);
  else renderHome();
}

boot().catch((e) => {
  document.body.innerHTML = `<p style="padding:2rem">Couldn't load the game: ${esc(errMsg(e))}</p>`;
});
