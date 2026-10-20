// Contract tests: runs a local Hardhat EVM and exercises BumperBalls through viem.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  parseEther,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hardhat } from "viem/chains";
import { domain, ticketTypes, resultTypes, MatchStatus } from "../shared/eip712.ts";

const PORT = 8547;
const rpc = `http://127.0.0.1:${PORT}`;
const { abi, bytecode } = JSON.parse(fs.readFileSync("build/BumperBalls.json", "utf8"));

// Hardhat's well-known dev accounts
const keys = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as const;
const [owner, alice, bob, carol, dave, feeSink] = keys.map((k) => privateKeyToAccount(k));
const signerKey = generatePrivateKey();
const signer = privateKeyToAccount(signerKey);
const rogue = privateKeyToAccount(generatePrivateKey());

let node: ChildProcess;
const pub = createPublicClient({ chain: hardhat, transport: http(rpc) });
const testClient = createTestClient({ chain: hardhat, mode: "hardhat", transport: http(rpc) });
const wallet = (acct: typeof owner) => createWalletClient({ account: acct, chain: hardhat, transport: http(rpc) });
let addr: Address;

const FEE = parseEther("0.01");
const SETTLE_TIMEOUT = 600n;

async function now() {
  return (await pub.getBlock()).timestamp;
}

let counter = 0;
const newMatchId = () => keccak256(toHex(`match-${counter++}-${Date.now()}`));

async function ticket(
  matchId: Hex,
  player: Address,
  opts: { fee?: bigint; maxPlayers?: number; joinDeadline: bigint; expiry?: bigint; by?: typeof signer },
) {
  const t = {
    matchId,
    player,
    entryFee: opts.fee ?? FEE,
    maxPlayers: opts.maxPlayers ?? 2,
    joinDeadline: opts.joinDeadline,
    ticketExpiry: opts.expiry ?? (await now()) + 300n,
  };
  const sig = await (opts.by ?? signer).signTypedData({
    domain: domain(hardhat.id, addr),
    types: ticketTypes,
    primaryType: "JoinTicket",
    message: t,
  });
  return { t, sig };
}

async function join(acct: typeof owner, matchId: Hex, o: Parameters<typeof ticket>[2] & { value?: bigint }) {
  const { t, sig } = await ticket(matchId, acct.address, o);
  const hash = await wallet(acct).writeContract({
    address: addr,
    abi,
    functionName: "join",
    args: [matchId, t.maxPlayers, t.joinDeadline, t.ticketExpiry, sig],
    value: o.value ?? t.entryFee,
  });
  return pub.waitForTransactionReceipt({ hash });
}

async function result(matchId: Hex, winner: Address, by = signer) {
  return by.signTypedData({
    domain: domain(hardhat.id, addr),
    types: resultTypes,
    primaryType: "MatchResult",
    message: { matchId, winner },
  });
}

async function call(acct: typeof owner, functionName: string, args: unknown[]) {
  const hash = await wallet(acct).writeContract({ address: addr, abi, functionName, args });
  return pub.waitForTransactionReceipt({ hash });
}

async function rejects(p: Promise<unknown>, err: string) {
  await assert.rejects(p, (e: Error) => {
    assert.match(String(e.message), new RegExp(err));
    return true;
  });
}

const getMatch = (id: Hex) => pub.readContract({ address: addr, abi, functionName: "getMatch", args: [id] }) as Promise<any>;
const balanceIn = (a: Address) => pub.readContract({ address: addr, abi, functionName: "balances", args: [a] }) as Promise<bigint>;

before(async () => {
  node = spawn("npx", ["hardhat", "node", "--port", String(PORT)], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const hash = await wallet(owner).deployContract({
    abi,
    bytecode,
    args: [owner.address, signer.address, feeSink.address, 500, SETTLE_TIMEOUT],
  });
  addr = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
});

after(() => node?.kill());

test("full 2-player match pays the winner minus 5% fee", async () => {
  const id = newMatchId();
  const jd = (await now()) + 600n;
  await join(alice, id, { joinDeadline: jd });
  assert.equal((await getMatch(id)).status, MatchStatus.Open);
  await join(bob, id, { joinDeadline: jd });
  const m = await getMatch(id);
  assert.equal(m.status, MatchStatus.Full);
  assert.equal(m.playerCount, 2);

  const before = await pub.getBalance({ address: bob.address });
  const rcpt = await call(bob, "claim", [id, bob.address, await result(id, bob.address)]);
  const after = await pub.getBalance({ address: bob.address });
  const gas = rcpt.gasUsed * rcpt.effectiveGasPrice;
  assert.equal(after - before + gas, (FEE * 2n * 95n) / 100n);
  assert.equal(await balanceIn(feeSink.address), (FEE * 2n * 5n) / 100n);
  assert.equal((await getMatch(id)).status, MatchStatus.Settled);
});

test("4-player match, anyone can submit the result", async () => {
  const id = newMatchId();
  const jd = (await now()) + 600n;
  for (const p of [alice, bob, carol, dave]) await join(p, id, { joinDeadline: jd, maxPlayers: 4 });
  await call(owner, "settle", [id, carol.address, await result(id, carol.address)]);
  assert.equal(await balanceIn(carol.address), (FEE * 4n * 95n) / 100n);
  await call(carol, "withdraw", []);
  assert.equal(await balanceIn(carol.address), 0n);
});

test("rejects forged tickets, wrong fee, wrong params, double join, and other players' tickets", async () => {
  const id = newMatchId();
  const jd = (await now()) + 600n;
  await rejects(join(alice, id, { joinDeadline: jd, by: rogue }), "BadSignature");
  await join(alice, id, { joinDeadline: jd });
  await rejects(join(bob, id, { joinDeadline: jd, fee: FEE * 2n }), "WrongFee");
  await rejects(join(bob, id, { joinDeadline: jd, maxPlayers: 3 }), "BadParams");
  await rejects(join(alice, id, { joinDeadline: jd }), "AlreadyJoined");
  // carol tries to use a ticket issued to bob
  const { t, sig } = await ticket(id, bob.address, { joinDeadline: jd });
  await rejects(
    wallet(carol).writeContract({
      address: addr,
      abi,
      functionName: "join",
      args: [id, t.maxPlayers, t.joinDeadline, t.ticketExpiry, sig],
      value: FEE,
    }),
    "BadSignature",
  );
  await rejects(join(bob, id, { joinDeadline: jd, expiry: (await now()) - 1n }), "TicketExpired");
});

test("rejects forged results and non-player winners", async () => {
  const id = newMatchId();
  const jd = (await now()) + 600n;
  await join(alice, id, { joinDeadline: jd });
  await rejects(call(alice, "settle", [id, alice.address, await result(id, alice.address)]), "MatchNotFull");
  await join(bob, id, { joinDeadline: jd });
  await rejects(call(alice, "settle", [id, alice.address, await result(id, alice.address, rogue)]), "BadSignature");
  await rejects(call(alice, "settle", [id, carol.address, await result(id, carol.address)]), "NotAPlayer");
  // a result signed for another match can't be replayed here
  const other = newMatchId();
  await rejects(call(alice, "settle", [id, alice.address, await result(other, alice.address)]), "BadSignature");
  await call(alice, "settle", [id, alice.address, await result(id, alice.address)]);
  await rejects(call(alice, "settle", [id, alice.address, await result(id, alice.address)]), "MatchNotFull");
});

test("leave before full refunds immediately", async () => {
  const id = newMatchId();
  const jd = (await now()) + 600n;
  await join(alice, id, { joinDeadline: jd, maxPlayers: 3 });
  await join(bob, id, { joinDeadline: jd, maxPlayers: 3 });
  const before = await pub.getBalance({ address: alice.address });
  const r = await call(alice, "leave", [id]);
  assert.equal(await pub.getBalance({ address: alice.address }) - before + r.gasUsed * r.effectiveGasPrice, FEE);
  const m = await getMatch(id);
  assert.equal(m.playerCount, 1);
  assert.equal(m.players[0], bob.address);
});

test("unfilled match: refunds after join deadline", async () => {
  const id = newMatchId();
  const jd = (await now()) + 60n;
  await join(alice, id, { joinDeadline: jd });
  await rejects(call(alice, "refund", [id]), "NotRefundable");
  await testClient.increaseTime({ seconds: 61 });
  await testClient.mine({ blocks: 1 });
  await rejects(join(bob, id, { joinDeadline: jd }), "JoinClosed");
  await call(alice, "refund", [id]);
  await rejects(call(alice, "refund", [id]), "NotRefundable");
  await rejects(call(bob, "refund", [id]), "NotAPlayer");
});

test("unsettled full match: everyone refunds after settle timeout, and late results are refused", async () => {
  const id = newMatchId();
  const jd = (await now()) + 600n;
  await join(alice, id, { joinDeadline: jd });
  await join(bob, id, { joinDeadline: jd });
  await rejects(call(alice, "refund", [id]), "NotRefundable");
  await testClient.increaseTime({ seconds: Number(SETTLE_TIMEOUT) + 1 });
  await testClient.mine({ blocks: 1 });
  await rejects(call(alice, "settle", [id, alice.address, await result(id, alice.address)]), "NotRefundable");
  await call(alice, "refund", [id]);
  await call(bob, "refund", [id]);
  assert.equal((await getMatch(id)).status, MatchStatus.Cancelled);
});

test("server-cancelled match (zero winner) credits everyone their stake", async () => {
  const id = newMatchId();
  const jd = (await now()) + 600n;
  await join(alice, id, { joinDeadline: jd });
  await join(bob, id, { joinDeadline: jd });
  const a0 = await balanceIn(alice.address);
  await call(bob, "settle", [id, zeroAddress, await result(id, zeroAddress)]);
  assert.equal(await balanceIn(alice.address), a0 + FEE);
  await rejects(call(alice, "refund", [id]), "NotRefundable"); // no double refund
});

test("admin changes don't affect running matches; fee cap and pause hold", async () => {
  const id = newMatchId();
  const jd = (await now()) + 600n;
  await join(alice, id, { joinDeadline: jd });
  // owner rotates signer and raises fee mid-match
  await call(owner, "setSigner", [rogue.address]);
  await call(owner, "setFee", [1000, feeSink.address]);
  await rejects(call(owner, "setFee", [1001, feeSink.address]), "BadParams");
  // bob's ticket from the original signer still matches the snapshot
  await join(bob, id, { joinDeadline: jd });
  // the new signer can't settle the old match
  await rejects(call(alice, "settle", [id, alice.address, await result(id, alice.address, rogue)]), "BadSignature");
  const fs0 = await balanceIn(feeSink.address);
  await call(alice, "settle", [id, alice.address, await result(id, alice.address)]);
  assert.equal((await balanceIn(feeSink.address)) - fs0, (FEE * 2n * 5n) / 100n); // still 5%
  await rejects(call(alice, "setPaused", [true]), "OwnableUnauthorizedAccount");
  await call(owner, "setPaused", [true]);
  await rejects(join(alice, newMatchId(), { joinDeadline: jd, by: rogue }), "IsPaused");
  await call(alice, "withdraw", []); // withdrawals still work while paused
  await call(owner, "setPaused", [false]);
  await call(owner, "setSigner", [signer.address]);
  await call(owner, "setFee", [500, feeSink.address]);
});

test("fee splitter pays the house cut 69/31 and can't be re-entered or redirected", async () => {
  const sp = JSON.parse(fs.readFileSync("build/FeeSplitter.json", "utf8"));
  const a = privateKeyToAccount(generatePrivateKey()).address;
  const b = privateKeyToAccount(generatePrivateKey()).address;
  const dh = await wallet(owner).deployContract({ abi: sp.abi, bytecode: sp.bytecode, args: [addr, a, b, 6900] });
  const splitter = (await pub.waitForTransactionReceipt({ hash: dh })).contractAddress!;
  await rejects(
    wallet(owner).deployContract({ abi: sp.abi, bytecode: sp.bytecode, args: [addr, a, zeroAddress, 6900] }).then((h) => pub.waitForTransactionReceipt({ hash: h })),
    "BadConfig|revert",
  );
  await call(owner, "setFee", [500, splitter]);
  const id = newMatchId();
  const jd = (await now()) + 600n;
  await join(alice, id, { joinDeadline: jd });
  await join(bob, id, { joinDeadline: jd });
  await call(carol, "settle", [id, alice.address, await result(id, alice.address)]);
  const fee = (FEE * 2n * 500n) / 10_000n;
  assert.equal(await balanceIn(splitter), fee);
  // anyone can trigger the payout; the money only ever goes to the two fixed wallets
  const ph = await wallet(dave).writeContract({ address: splitter, abi: sp.abi, functionName: "payout", args: [] });
  await pub.waitForTransactionReceipt({ hash: ph });
  assert.equal(await pub.getBalance({ address: a }), (fee * 6900n) / 10_000n);
  assert.equal(await pub.getBalance({ address: b }), fee - (fee * 6900n) / 10_000n);
  assert.equal(await balanceIn(splitter), 0n);
  // a second payout with nothing pending is a harmless no-op
  await pub.waitForTransactionReceipt({ hash: await wallet(dave).writeContract({ address: splitter, abi: sp.abi, functionName: "payout", args: [] }) });
  await call(owner, "setFee", [500, feeSink.address]);
});
