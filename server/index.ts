// Bumper Balls game server (Node): serves the web client, signs players in
// with their wallet, hands out join tickets, and runs every match itself.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { toHex, getAddress, type Address, type Hex } from "viem";
import { TIERS, CHAINS, JOIN_WINDOW_SEC, TICKET_TTL_SEC } from "../shared/config";
import { login, verifyToken } from "./auth";
import { signerAddress, rpcUrl, signTicket } from "./chain";
import { loadEnv } from "./env";
import { Room, type Config } from "./room";
import { ensureContract, type ContractStatus } from "./deploy";

const env = loadEnv();
const PORT = Number(process.env.PORT || 8787);
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || "web/dist");
const DATA_DIR = process.env.DATA_DIR || "";
const MAX_CONNS_PER_IP = 8;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ----------------------------------------------------------------- rooms

const rooms = new Map<string, Room>();
const currentTier = new Map<string, string>(); // tierId -> matchId
let currentPractice = "";

// paid matches in play survive a restart only as "call it off": remember them on disk
const activeFile = DATA_DIR ? path.join(DATA_DIR, "active-paid.json") : "";
const activePaid = new Set<string>(activeFile && fs.existsSync(activeFile) ? JSON.parse(fs.readFileSync(activeFile, "utf8")) : []);
const persist = {
  activePaid(id: string, on: boolean) {
    on ? activePaid.add(id) : activePaid.delete(id);
    if (activeFile) fs.writeFileSync(activeFile, JSON.stringify([...activePaid]));
  },
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
  const tier = TIERS.find((t) => t.id === tierId);
  if (!tier) return { status: 400, body: { error: "unknown tier" } };
  if (contract.state !== "live") return { status: 503, body: { error: "Paid matches aren't open yet." } };
  const now = Math.floor(Date.now() / 1000);
  let room = rooms.get(currentTier.get(tier.id) ?? "");
  if (!room || !room.joinable || (room.cfg.joinDeadline ?? 0) - now < TICKET_TTL_SEC + 30 || stale === room.cfg.matchId) {
    room = makeRoom({ mode: "paid", matchId: randomId(), tierId: tier.id, entryFee: tier.entryFeeWei, maxPlayers: tier.maxPlayers, joinDeadline: now + JOIN_WINDOW_SEC });
    currentTier.set(tier.id, room.cfg.matchId);
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

function practiceRoom() {
  let room = rooms.get(currentPractice);
  if (!room || !room.joinable) {
    room = makeRoom({ mode: "practice", matchId: `practice-${crypto.randomUUID()}`, maxPlayers: 4 });
    currentPractice = room.cfg.matchId;
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
  const keep = new Set([...currentTier.values(), currentPractice]);
  for (const [id, r] of rooms) if (r.idle && !keep.has(id)) rooms.delete(id);
}, 60_000).unref();

// ---------------------------------------------------------------- contract

let contract: ContractStatus = { state: "checking", address: getAddress(env.CONTRACT_ADDRESS) };
ensureContract(env, (s) => {
  contract = s;
  if (s.state === "live") log(`escrow live at ${s.address}`);
});

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
  ".json": "application/json",
  ".woff2": "font/woff2",
};

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
        paid: contract,
        signer: signerAddress(env),
        walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || null,
        tiers: TIERS,
      });
    }
    if (p === "/api/login" && req.method === "POST") {
      const r = await login(env, req.headers.host || "", await readBody(req));
      return sendJson(res, "error" in r ? 401 : 200, r);
    }
    if (p === "/api/queue" && req.method === "POST") {
      const address = await verifyToken(env, req.headers.authorization?.replace(/^Bearer /, ""));
      if (!address) return sendJson(res, 401, { error: "sign in first" });
      const body = await readBody(req);
      const r = await queuePaid(String(body.tierId), address, body.stale);
      return sendJson(res, r.status, r.body);
    }
    if (p === "/api/practice" && req.method === "POST") return sendJson(res, 200, { roomId: practiceRoom() });
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
  if (room.cfg.mode === "paid" && !address) return reject(401, "Unauthorized");
  const name =
    String(url.searchParams.get("name") || "")
      .replace(/[^\p{L}\p{N} _.'-]/gu, "")
      .trim()
      .slice(0, 16) || "Player";
  wss.handleUpgrade(req, socket, head, (ws) => {
    ipConns.set(ip, (ipConns.get(ip) ?? 0) + 1);
    ws.on("close", () => ipConns.set(ip, Math.max(0, (ipConns.get(ip) ?? 1) - 1)));
    room.attach(ws, address, name);
  });
});

server.listen(PORT, () => log(`Bumper Balls on :${PORT} (chain ${env.CHAIN_ID}, escrow ${env.CONTRACT_ADDRESS})`));

