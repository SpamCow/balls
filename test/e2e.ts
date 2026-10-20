// End-to-end match against a running stack (local chain + wrangler dev):
//   BASE=http://127.0.0.1:8787 npx tsx test/e2e.ts
// Two wallets sign in, pay into a duel, play it out (one chases, one idles),
// and the winner claims the pot from the contract.
import { createPublicClient, createWalletClient, http, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bumperBallsAbi } from "../shared/abi.ts";
import { SNAP_STRIDE } from "../shared/physics.ts";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const cfg = await (await fetch(`${BASE}/api/config`)).json();
const chain = { id: cfg.chainId, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } } as const;
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const host = new URL(BASE).host;
// TIER=battle-2-2000000000000000 plays a paid battle duel for 0.002 ETH instead
const TIER = process.env.TIER ?? "duel-s";
const ENTRY = TIER === "duel-s" ? 1_000_000_000_000_000n : BigInt(TIER.split("-")[2]);
const PRIZE = (ENTRY * 2n * 95n) / 100n;

const keys: Hex[] = [
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];

async function signIn(key: Hex) {
  const acct = privateKeyToAccount(key);
  const issued = new Date().toISOString();
  const nonce = "a1b2c3d4e5f60718" + Math.floor(Math.random() * 1e8).toString(16).padStart(8, "0");
  const message = `${host} wants you to sign in to Bumper Balls.\n\nThis only proves you own this wallet. It costs nothing and moves no funds.\n\nAddress: ${acct.address}\nChain ID: ${cfg.chainId}\nIssued: ${issued}\nNonce: ${nonce}`;
  const signature = await acct.signMessage({ message });
  const r = await fetch(`${BASE}/api/login`, { method: "POST", body: JSON.stringify({ address: acct.address, issued, nonce, signature }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`login: ${j.error}`);
  return { acct, token: j.token as string, wallet: createWalletClient({ account: acct, chain, transport: http(cfg.rpcUrl) }) };
}

// bad signature must be refused
{
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    body: JSON.stringify({ address: privateKeyToAccount(keys[0]).address, issued: new Date().toISOString(), nonce: "00112233445566778899", signature: "0x" + "11".repeat(65) }),
  });
  if (r.status !== 401) throw new Error("forged login accepted");
  const q = await fetch(`${BASE}/api/queue`, { method: "POST", headers: { authorization: "Bearer 0xabc.999999999999.forged" }, body: "{}" });
  if (q.status !== 401) throw new Error("forged token accepted");
  console.log("✓ forged sign-in and forged session token are rejected");
}

const players = await Promise.all(keys.map(signIn));
console.log("✓ both players signed in");

let matchId: Hex | null = null;
for (const p of players) {
  const r = await fetch(`${BASE}/api/queue`, { method: "POST", headers: { authorization: `Bearer ${p.token}` }, body: JSON.stringify({ tierId: TIER }) });
  const t = await r.json();
  if (!r.ok) throw new Error(`queue: ${t.error}`);
  if (matchId && t.matchId !== matchId) throw new Error("players were put in different matches");
  matchId = t.matchId;
  const hash = await p.wallet.writeContract({
    address: cfg.contract,
    abi: bumperBallsAbi,
    functionName: "join",
    args: [t.matchId, t.maxPlayers, BigInt(t.joinDeadline), BigInt(t.ticketExpiry), t.sig],
    value: BigInt(t.entryFee),
  });
  await pub.waitForTransactionReceipt({ hash });
}
console.log(`✓ both paid into match ${matchId}`);

// a third queue request must now get a different (fresh) match
await new Promise((r) => setTimeout(r, 1500));

type Over = { winnerSeat: number | null; winner: Address; sig: Hex };
const results = await Promise.all(
  players.map(
    (p, i) =>
      new Promise<{ over: Over; you: number; snaps: number }>((resolve, reject) => {
        const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws/${matchId}?token=${encodeURIComponent(p.token)}`);
        let you = -1;
        let snap: number[] | null = null;
        let snaps = 0;
        let timer: ReturnType<typeof setInterval> | null = null;
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data as string);
          if (m.t === "hello" || m.t === "seats") you = m.you;
          if (m.t === "start" && i === 0) {
            // player 0 chases player 1 and dashes when close; player 1 idles
            timer = setInterval(() => {
              if (!snap) return;
              const me = 2 + you * SNAP_STRIDE;
              const them = 2 + (1 - you) * SNAP_STRIDE;
              const dx = snap[them] - snap[me];
              const dy = snap[them + 1] - snap[me + 1];
              const d = Math.hypot(dx, dy) || 1;
              ws.send(JSON.stringify({ t: "in", x: dx / d, y: dy / d, dash: d < 3 }));
            }, 33);
          }
          if (m.t === "s") {
            snap = m.d;
            snaps++;
          }
          if (m.t === "over") {
            if (timer) clearInterval(timer);
            ws.close();
            resolve({ over: m, you, snaps });
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("match timed out")), 150_000);
      }),
  ),
);
const { over } = results[0];
console.log(`✓ match played: ${results[0].snaps} snapshots, winner seat ${over.winnerSeat} (${over.winner})`);
// in battle mode the naive chaser can roll into the hole, so either player may win there
if (over.winnerSeat === null || (!TIER.startsWith("battle") && over.winnerSeat !== results[0].you)) throw new Error("expected the active player to win");
const w = over.winnerSeat === results[0].you ? 0 : 1;

// a loser can't claim with the winner's signature
const loser = players[1 - w];
try {
  await pub.simulateContract({ account: loser.acct, address: cfg.contract, abi: bumperBallsAbi, functionName: "claim", args: [matchId!, loser.acct.address, over.sig] });
  throw new Error("loser claim should fail");
} catch (e: any) {
  // BadSignature if the match is still unsettled; NothingToWithdraw once the server settled it
  if (!/BadSignature|NothingToWithdraw/.test(e.message)) throw e;
}
console.log("✓ loser can't reuse the winner's signature");

const winner = players[w];
const before = await pub.getBalance({ address: winner.acct.address });
const hash = await winner.wallet.writeContract({ address: cfg.contract, abi: bumperBallsAbi, functionName: "claim", args: [matchId!, over.winner, over.sig] });
const rc = await pub.waitForTransactionReceipt({ hash });
const gained = (await pub.getBalance({ address: winner.acct.address })) - before + rc.gasUsed * rc.effectiveGasPrice;
console.log(`✓ winner claimed ${Number(gained) / 1e18} ETH`);
if (gained !== PRIZE) throw new Error(`unexpected payout ${gained}`);

// the contract sends the house cut straight to the fee wallets when the match settles
{
  const read = (functionName: "feeRecipient" | "feeRecipient2" | "feeShareBps") => pub.readContract({ address: cfg.contract, abi: bumperBallsAbi, functionName });
  const [a, b, share] = (await Promise.all([read("feeRecipient"), read("feeRecipient2"), read("feeShareBps")])) as [Address, Address, number];
  const fee = (PRIZE * 5n) / 95n; // 5% of the pot
  const wantA = (fee * BigInt(share)) / 10_000n;
  const gotA = await pub.getBalance({ address: a });
  const gotB = a === b ? 0n : await pub.getBalance({ address: b });
  if (process.env.EXPECT_FRESH_FEE_WALLETS && (gotA !== wantA || gotB !== fee - wantA)) throw new Error(`house cut wrong: ${gotA} / ${gotB}, wanted ${wantA} / ${fee - wantA}`);
  if (gotA === 0n) throw new Error("house cut not paid");
  console.log(`✓ house cut paid straight to the fee wallets: ${Number(gotA) / 1e18} + ${Number(gotB) / 1e18} ETH (${share / 100}% / ${100 - share / 100}%)`);
}

const status = await (await fetch(`${BASE}/api/match/${matchId}`)).json();
if (status.phase !== "over" || status.joinable) throw new Error("room state wrong after match");

// practice: a guest joins with no wallet and plays against bots until the end
const pr = await (await fetch(`${BASE}/api/practice`, { method: "POST" })).json();
const practice = await new Promise<any>((resolve, reject) => {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws/${pr.roomId}`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string);
    if (m.t === "start") ws.send(JSON.stringify({ t: "in", x: 0.3, y: 0, dash: false }));
    if (m.t === "over") {
      ws.close();
      resolve(m);
    }
  };
  ws.onerror = () => reject(new Error("practice ws error"));
  setTimeout(() => reject(new Error("practice timed out")), 150_000);
});
console.log(`✓ practice match vs bots finished, winner seat ${practice.winnerSeat}`);
// friends room: a host and a guest with names, host-only Start, no bots, then a rematch
const fr = await (await fetch(`${BASE}/api/friends`, { method: "POST" })).json();
if (!/^friends-[a-z0-9]{5}$/.test(fr.roomId)) throw new Error(`bad friends room id ${fr.roomId}`);
function friend(name: string) {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws/${fr.roomId}?name=${encodeURIComponent(name)}`);
  const st: { you: number | null; last: any; overs: any[]; snap: number[] | null; starts: number } = { you: null, last: null, overs: [], snap: null, starts: 0 };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string);
    if (m.t === "hello" || m.t === "seats") (st.you = m.you), (st.last = m);
    if (m.t === "s") st.snap = m.d;
    if (m.t === "start") st.starts++;
    if (m.t === "over") st.overs.push(m);
  };
  return { ws, st, ready: new Promise((r) => (ws.onopen = r)) };
}
const fhost = friend("Ned");
await fhost.ready;
await new Promise((r) => setTimeout(r, 300));
const guest = friend("Sam<script>");
await guest.ready;
await new Promise((r) => setTimeout(r, 500));
if (fhost.st.last.host !== fhost.st.you) throw new Error("first player should host");
if (!fhost.st.last.names.includes("Ned") || !fhost.st.last.names.includes("Samscript")) throw new Error(`names wrong: ${fhost.st.last.names}`);
guest.ws.send(JSON.stringify({ t: "begin" }));
await new Promise((r) => setTimeout(r, 800));
if (fhost.st.starts || fhost.st.last.phase !== "waiting") throw new Error("guest was able to start the game");
for (let round = 1; round <= 2; round++) {
  fhost.ws.send(JSON.stringify({ t: "begin", bots: false }));
  const t0 = Date.now();
  const chase = setInterval(() => {
    const s = fhost.st.snap;
    if (!s || fhost.st.you === null) return;
    const me = 2 + fhost.st.you * SNAP_STRIDE;
    const them = 2 + guest.st.you! * SNAP_STRIDE;
    const dx = s[them] - s[me], dy = s[them + 1] - s[me + 1], d = Math.hypot(dx, dy) || 1;
    fhost.ws.send(JSON.stringify({ t: "in", x: dx / d, y: dy / d, dash: d < 3 }));
  }, 33);
  while (fhost.st.overs.length < round) {
    if (Date.now() - t0 > 140_000) throw new Error("friends round timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
  clearInterval(chase);
  const players = (fhost.st.snap!.length - 2) / SNAP_STRIDE;
  if (players !== 2) throw new Error(`expected 2 balls without bots, got ${players}`);
  console.log(`✓ friends round ${round}: winner seat ${fhost.st.overs[round - 1].winnerSeat} (host is seat ${fhost.st.you})`);
  await new Promise((r) => setTimeout(r, 500));
}
fhost.ws.close();
guest.ws.close();
console.log("ALL E2E CHECKS PASSED");
process.exit(0);
