// Bumper Balls game server (Node): serves the web client, signs players in
// with their wallet, hands out join tickets, and runs every match itself.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { toHex, getAddress, isAddress, formatEther, parseEther, type Address, type Hex } from "viem";
import { CHAINS, JOIN_WINDOW_SEC, TICKET_TTL_SEC, PRESET_BETS, MIN_BET_WEI, DEFAULT_MAX_BET_ETH, parseTier } from "../shared/config";
import { login, verifyToken } from "./auth";
import { signerAddress, rpcUrl, signTicket, sweepDeployer, deployerClients, refundStale } from "./chain";
import { loadEnv } from "./env";
import { Room, type Config, type Variant } from "./room";
import { ensureContract, type ContractStatus } from "./deploy";
import { createPlayerCount, createProfiles } from "./profiles";
import { syncFees } from "./fees";

const env = loadEnv();
// Feature switches. SIGN_IN and PAID_PLAY take on or off and are on when unset. Off only hides the
// feature: refunds and payouts for earlier matches keep running.
const switchOn = (v: string | undefined) => (v ? /^(on|yes|true|1)$/i.test(v.trim()) : true);
const SIGN_IN = switchOn(process.env.SIGN_IN);
const PAID_PLAY = SIGN_IN && switchOn(process.env.PAID_PLAY); // paying needs a signed-in wallet
const PORT = Number(process.env.PORT || 8787);
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || "web/dist");
const DATA_DIR = process.env.DATA_DIR || "";
const MAX_CONNS_PER_IP = 8;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
// MAX_BET_ETH: the biggest entry a player may pick (default 1 ETH)
const MAX_BET_WEI = (() => {
  try {
    return parseEther(process.env.MAX_BET_ETH?.trim() || DEFAULT_MAX_BET_ETH);
  } catch {
    log("MAX_BET_ETH isn't a number, using", DEFAULT_MAX_BET_ETH);
    return parseEther(DEFAULT_MAX_BET_ETH);
  }
})();
const MAX_WAITING_PAID = 200; // open paid matches waiting for players at once

// ----------------------------------------------------------------- rooms

const rooms = new Map<string, Room>();
const currentTier = new Map<string, string>(); // tierId -> matchId
let currentPractice = "";
let currentBattle = "";
let currentRace = "";

// paid matches in play survive a restart only as "call it off": remember them on disk
const activeFile = DATA_DIR ? path.join(DATA_DIR, "active-paid.json") : "";
const activePaid = new Set<string>(activeFile && fs.existsSync(activeFile) ? JSON.parse(fs.readFileSync(activeFile, "utf8")) : []);
const profiles = createProfiles(DATA_DIR);
const players = createPlayerCount(DATA_DIR, profiles.addresses);
const persist = {
  activePaid(id: string, on: boolean) {
    on ? activePaid.add(id) : activePaid.delete(id);
    if (activeFile) fs.writeFileSync(activeFile, JSON.stringify([...activePaid]));
  },
  record: (address: Address, won: boolean, prizeWei: bigint, board: "free" | "paid", entryWei: bigint) => profiles.record(address, won, prizeWei, board, entryWei),
  netOf: (address: Address) => profiles.net(address),
  played: (ids: string[]) => players.add(ids),
  nameOf: (address: Address) => profiles.name(address),
};

function makeRoom(cfg: Config) {
  const r = new Room(cfg, env, persist);
  rooms.set(cfg.matchId, r);
  return r;
}

const randomId = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

async function queuePaid(tierId: string, address: Address, stale?: string) {
  const tier = parseTier(tierId, MAX_BET_WEI);
  if (typeof tier === "string") return { status: 400, body: { error: tier } };
  if (!PAID_PLAY) return { status: 503, body: { error: "Paid matches are turned off on this site." } };
  if (contract.state !== "live") return { status: 503, body: { error: "Paid matches aren't open yet." } };
  const now = Math.floor(Date.now() / 1000);
  let room = rooms.get(currentTier.get(tier.id) ?? "");
  if (!room || !room.joinable || (room.cfg.joinDeadline ?? 0) - now < TICKET_TTL_SEC + 30 || stale === room.cfg.matchId) {
    if (waitingPaid().length >= MAX_WAITING_PAID) return { status: 503, body: { error: "Too many matches are waiting for players. Join one of the open matches instead." } };
    room = makeRoom({
      mode: "paid",
      variant: tier.variant,
      matchId: randomId(),
      tierId: tier.id,
      entryFee: tier.entryFeeWei,
      maxPlayers: tier.maxPlayers,
      joinDeadline: now + JOIN_WINDOW_SEC,
    });
    currentTier.set(tier.id, room.cfg.matchId);
    pendingPaid.set(room.cfg.matchId, room.cfg.joinDeadline!);
    savePending();
  }
  const t = {
    matchId: room.cfg.matchId as Hex,
    player: address,
    entryFee: BigInt(tier.entryFeeWei),
    maxPlayers: tier.maxPlayers,
    joinDeadline: BigInt(room.cfg.joinDeadline!),
    ticketExpiry: BigInt(Math.min(now + TICKET_TTL_SEC, room.cfg.joinDeadline! - 1)),
  };
  const sig = await signTicket(env, t);
  return {
    status: 200,
    body: { matchId: t.matchId, entryFee: tier.entryFeeWei, maxPlayers: tier.maxPlayers, joinDeadline: room.cfg.joinDeadline, ticketExpiry: Number(t.ticketExpiry), sig },
  };
}

/** Paid matches still taking players. */
function waitingPaid() {
  return [...rooms.values()].filter((r) => r.cfg.mode === "paid" && r.joinable);
}

/** Open paid matches someone has already paid into, for the lobby's list. */
function openMatches() {
  const now = Math.floor(Date.now() / 1000);
  return waitingPaid()
    .map((r) => ({ r, s: r.publicState() }))
    .filter(({ r, s }) => s.seats.length > 0 && (r.cfg.joinDeadline ?? 0) - now > TICKET_TTL_SEC + 30)
    // closest to full first, then biggest bet
    .sort((a, b) => b.s.seats.length / b.s.maxPlayers - a.s.seats.length / a.s.maxPlayers || (BigInt(b.s.entryFee ?? 0) > BigInt(a.s.entryFee ?? 0) ? 1 : -1))
    .slice(0, 20)
    .map(({ s }) => ({ matchId: s.matchId, tierId: s.tierId, players: s.seats.length, maxPlayers: s.maxPlayers, entryFee: s.entryFee, variant: s.variant, names: s.names }));
}

function practiceRoom(variant: Variant) {
  let room = rooms.get(variant === "race" ? currentRace : variant === "battle" ? currentBattle : currentPractice);
  if (!room || !room.joinable) {
    room = makeRoom({ mode: "practice", variant, matchId: `practice-${crypto.randomUUID()}`, maxPlayers: 4 });
    if (variant === "race") currentRace = room.cfg.matchId;
    else if (variant === "battle") currentBattle = room.cfg.matchId;
    else currentPractice = room.cfg.matchId;
  }
  return room.cfg.matchId;
}

function friendsRoom() {
  let code = newCode();
  while (rooms.has(`friends-${code}`)) code = newCode();
  return makeRoom({ mode: "friends", matchId: `friends-${code}`, code, maxPlayers: 4 }).cfg.matchId;
}

// forget empty rooms after a while
setInterval(() => {
  const keep = new Set([...currentTier.values(), currentPractice, currentBattle, currentRace]);
  for (const [id, r] of rooms) if (r.idle && !keep.has(id)) rooms.delete(id);
}, 60_000).unref();

// ---------------------------------------------------------------- contract

// SWEEP_DEPLOYER_TO=0x...: send the deployer's leftover gas money to that wallet once the
// contract check is done (for taking the site down). Remove the setting to run normally.
const sweepTo = process.env.SWEEP_DEPLOYER_TO?.trim();
let swept = false;
function sweep() {
  if (!sweepTo || swept) return;
  swept = true;
  if (!isAddress(sweepTo)) return log("SWEEP_DEPLOYER_TO is not a wallet address, so nothing was sent");
  for (const key of [env.DEPLOYER_KEY, ...env.OLD_DEPLOYER_KEYS])
    sweepDeployer(env, getAddress(sweepTo), key)
      .then((r) => r && log(`sent ${formatEther(r.sent)} ETH from the deployer ${r.from} to ${sweepTo} in ${r.hash}`))
      .catch((e) => log("couldn't send the deployer's ETH:", (e as Error).message.split("\n")[0]));
}

// Each contract version has its own deployer. Move any gas money left in the old ones to
// the current deployer so the owner doesn't have to fund it again.
if (!sweepTo)
  for (const key of env.OLD_DEPLOYER_KEYS)
    sweepDeployer(env, deployerClients(env).account.address, key)
      .then((r) => r && log(`moved ${formatEther(r.sent)} ETH of gas money from the old deployer ${r.from} to ${deployerClients(env).account.address} in ${r.hash}`))
      .catch((e) => log("couldn't move the old deployer's ETH:", (e as Error).message.split("\n")[0]));

let contract: ContractStatus = { state: "checking", address: getAddress(env.CONTRACT_ADDRESS) };
ensureContract(env, (s) => {
  contract = s;
  if (s.state === "live") {
    log(`escrow live at ${s.address}`);
    if (!sweepTo) syncFees(env);
  }
  if (s.state !== "checking" && s.state !== "deploying") sweep();
});

// Paid matches that may still hold stakes. Once one goes stale (it never filled, or was
// never settled) the server sends everyone's stake back itself, so nobody has to press Refund.
const pendingFile = DATA_DIR ? path.join(DATA_DIR, "pending-paid.json") : "";
const pendingPaid = new Map<string, number>(pendingFile && fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, "utf8")) : []);
const savePending = () => pendingFile && fs.writeFileSync(pendingFile, JSON.stringify([...pendingPaid]));
let refunding = false;
async function refundSweep() {
  if (refunding || contract.state !== "live" || sweepTo) return;
  refunding = true;
  try {
    for (const [id, joinDeadline] of [...pendingPaid]) {
      try {
        const r = await refundStale(env, id as Hex, joinDeadline);
        if (r.hash) log(`sent the stakes back for ${id} in ${r.hash}`);
        if (r.done) pendingPaid.delete(id);
      } catch (e) {
        log(`couldn't refund ${id}:`, (e as Error).message.split("\n")[0]);
      }
    }
    savePending();
  } finally {
    refunding = false;
  }
}
setInterval(refundSweep, 60_000).unref();

// restore paid matches that were in play when the server stopped
for (const id of activePaid) {
  const r = makeRoom({ mode: "paid", matchId: id, maxPlayers: 4 });
  r.cancelAfterRestart().then(() => log(`called off ${id} after restart`));
}

// -------------------------------------------------------------------- http

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

// Ball skins: every image in the skins folder that ships with the site
// (web/public/skins in the repo). A skin's id is its file name.
const SKIN_FILE = /^[A-Za-z0-9_-]{1,40}\.(png|jpe?g|webp)$/i;
const SKINS = (() => {
  try {
    return fs.readdirSync(path.join(STATIC_DIR, "skins")).filter((f) => SKIN_FILE.test(f)).sort();
  } catch {
    return [];
  }
})();
const skinList = SKINS.map((id) => ({
  id,
  name: id.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase()),
  url: `/skins/${id}`,
}));

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8192) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

const ROOM_ID = /^(0x[0-9a-f]{64}|practice-[0-9a-f-]{36}|friends-[a-z0-9]{5})$/;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const p = url.pathname;
    if (p === "/healthz") return sendJson(res, 200, { ok: true });
    if (p === "/api/config") {
      const chainId = Number(env.CHAIN_ID);
      return sendJson(res, 200, {
        chainId,
        chainName: CHAINS[chainId]?.name,
        rpcUrl: rpcUrl(env),
        explorer: CHAINS[chainId]?.explorer,
        contract: contract.address,
        oldContracts: env.OLD_CONTRACTS,
        paid: contract,
        paidPlay: PAID_PLAY,
        signer: signerAddress(env),
        walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || null,
        privyAppId: SIGN_IN ? process.env.PRIVY_APP_ID || null : null,
        signIn: SIGN_IN,
        bets: { presets: PRESET_BETS, min: formatEther(MIN_BET_WEI), max: formatEther(MAX_BET_WEI) },
      });
    }
    if (p === "/api/login" && req.method === "POST") {
      const r = await login(env, req.headers.host || "", await readBody(req));
      return sendJson(res, "error" in r ? 401 : 200, r);
    }
    if (p === "/api/profile") {
      const address = await verifyToken(env, req.headers.authorization?.replace(/^Bearer /, ""));
      if (!address) return sendJson(res, 401, { error: "sign in first" });
      if (req.method === "POST") {
        const err = profiles.setName(address, (await readBody(req))?.name);
        if (err) return sendJson(res, 400, { error: err });
      }
      return sendJson(res, 200, profiles.get(address));
    }
    if (p === "/api/skins") return sendJson(res, 200, skinList);
    if (p === "/api/leaderboard") return sendJson(res, 200, { free: profiles.leaderboard("free"), paid: profiles.leaderboard("paid"), players: players.total, accounts: profiles.accounts() });
    if (p === "/api/queue" && req.method === "POST") {
      const address = await verifyToken(env, req.headers.authorization?.replace(/^Bearer /, ""));
      if (!address) return sendJson(res, 401, { error: "sign in first" });
      const body = await readBody(req);
      const r = await queuePaid(String(body.tierId), address, body.stale);
      return sendJson(res, r.status, r.body);
    }
    if (p === "/api/open") return sendJson(res, 200, PAID_PLAY ? openMatches() : []);
    if (p === "/api/practice" && req.method === "POST") return sendJson(res, 200, { roomId: practiceRoom(url.searchParams.get("variant") === "race" ? "race" : url.searchParams.get("battle") === "1" ? "battle" : "classic") });
    if (p === "/api/friends" && req.method === "POST") return sendJson(res, 200, { roomId: friendsRoom() });
    const m = p.match(/^\/api\/match\/([^/]+)$/);
    if (m) {
      const r = ROOM_ID.test(m[1]) ? rooms.get(m[1]) : undefined;
      return r ? sendJson(res, 200, { joinable: r.joinable, ...r.publicState() }) : sendJson(res, 404, { error: "no such match" });
    }
    if (p.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });

    // static files, falling back to the app shell
    let file = path.join(STATIC_DIR, decodeURIComponent(p));
    if (!file.startsWith(STATIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC_DIR, "index.html");
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": p.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    log("http error", (e as Error).message);
    if (!res.headersSent) sendJson(res, 500, { error: "server error" });
  }
});

// --------------------------------------------------------------- websockets

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const ipConns = new Map<string, number>();
const clientIp = (req: http.IncomingMessage) =>
  (process.env.TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url || "/", "http://x");
  const m = url.pathname.match(/^\/ws\/([^/]+)$/);
  const room = m && ROOM_ID.test(m[1]) ? rooms.get(m[1]) : undefined;
  const ip = clientIp(req);
  const reject = (code: number, msg: string) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
    socket.destroy();
  };
  if (!room) return reject(404, "Not Found");
  if ((ipConns.get(ip) ?? 0) >= MAX_CONNS_PER_IP) return reject(429, "Too Many Requests");
  const address = await verifyToken(env, url.searchParams.get("token"));
  // no sign-in (or no seat) just means watching: rooms only take input from seated players
  const name =
    (address && profiles.name(address)) ||
    String(url.searchParams.get("name") || "")
      .replace(/[^\p{L}\p{N} _.'-]/gu, "")
      .trim()
      .slice(0, 16) || "Player";
  wss.handleUpgrade(req, socket, head, (ws) => {
    ipConns.set(ip, (ipConns.get(ip) ?? 0) + 1);
    ws.on("close", () => ipConns.set(ip, Math.max(0, (ipConns.get(ip) ?? 1) - 1)));
    const skin = String(url.searchParams.get("skin") || "");
    const pid = String(url.searchParams.get("pid") || "");
    room.attach(ws, address, name, SKINS.includes(skin) ? skin : "", /^[0-9a-f]{32}$/.test(pid) ? pid : "");
  });
});

server.listen(PORT, () => log(`Bumper Balls on :${PORT} (chain ${env.CHAIN_ID}, escrow ${env.CONTRACT_ADDRESS})`));
if (!process.env.PRIVY_APP_ID) log("PRIVY_APP_ID is not set, so players can't sign in. Add the App ID from dashboard.privy.io (see the setup guide, Step 4).");

