import { createPublicClient, createWalletClient, http, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bumperBallsAbi } from "../shared/abi";
import { CHAINS } from "../shared/config";
import { domain, ticketTypes, resultTypes, MatchStatus, type Ticket } from "../shared/eip712";
import type { Env } from "./env";

export const rpcUrl = (env: Env) => env.RPC_URL || CHAINS[Number(env.CHAIN_ID)]?.rpc;

export function publicClient(env: Env) {
  return createPublicClient({ transport: http(rpcUrl(env), { retryCount: 2 }) });
}

export type OnchainMatch = {
  status: number;
  entryFee: bigint;
  maxPlayers: number;
  playerCount: number;
  joinDeadline: bigint;
  settleDeadline: bigint;
  players: Address[];
};

export async function readMatch(env: Env, matchId: Hex): Promise<OnchainMatch> {
  const m = (await publicClient(env).readContract({
    address: getAddress(env.CONTRACT_ADDRESS),
    abi: bumperBallsAbi,
    functionName: "getMatch",
    args: [matchId],
  })) as any;
  return {
    status: Number(m.status),
    entryFee: m.entryFee,
    maxPlayers: Number(m.maxPlayers),
    playerCount: Number(m.playerCount),
    joinDeadline: m.joinDeadline,
    settleDeadline: m.settleDeadline,
    players: (m.players as Address[]).slice(0, Number(m.playerCount)),
  };
}

const signer = (env: Env) => privateKeyToAccount(env.RESULT_SIGNER_KEY as Hex);
const dom = (env: Env) => domain(Number(env.CHAIN_ID), getAddress(env.CONTRACT_ADDRESS));

export const signerAddress = (env: Env) => signer(env).address;

export function signTicket(env: Env, t: Ticket) {
  return signer(env).signTypedData({ domain: dom(env), types: ticketTypes, primaryType: "JoinTicket", message: t });
}

export function signResult(env: Env, matchId: Hex, winner: Address) {
  return signer(env).signTypedData({ domain: dom(env), types: resultTypes, primaryType: "MatchResult", message: { matchId, winner } });
}

/**
 * Settle a finished match from the server's deployer key, so the prize and the
 * house cut are credited even if the winner never presses Claim (an unsettled
 * match turns refundable after the settle timeout). Anyone may call settle with
 * a valid result signature, so this only pays gas. Returns the tx hash, or null
 * if the match no longer needs settling.
 */
// Every transaction from the deployer key goes through here one at a time, so
// two of them never race for the same nonce.
let deployerQueue: Promise<unknown> = Promise.resolve();
export function deployerTx<T>(fn: () => Promise<T>): Promise<T> {
  const run = deployerQueue.then(fn, fn);
  deployerQueue = run.catch(() => {});
  return run;
}

export function deployerClients(env: Env, key = env.DEPLOYER_KEY) {
  const chainId = Number(env.CHAIN_ID);
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl(env)] } } } as const;
  const account = privateKeyToAccount(key as Hex);
  return {
    account,
    pub: createPublicClient({ chain, transport: http(rpcUrl(env), { retryCount: 2 }) }),
    wallet: createWalletClient({ account, chain, transport: http(rpcUrl(env), { retryCount: 2 }) }),
  };
}

export async function settleMatch(env: Env, matchId: Hex, winner: Address, sig: Hex): Promise<Hex | null> {
  const { account, pub, wallet } = deployerClients(env);
  const address = getAddress(env.CONTRACT_ADDRESS);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const hash = await deployerTx(async () => {
        if ((await readMatch(env, matchId)).status !== MatchStatus.Full) return null; // claimed or refunded already
        const { request } = await pub.simulateContract({ account, address, abi: bumperBallsAbi, functionName: "settle", args: [matchId, winner, sig] });
        const h = await wallet.writeContract(request);
        await pub.waitForTransactionReceipt({ hash: h });
        return h;
      });
      return hash;
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
  return null;
}

/**
 * Sends the stakes back from a paid match that went stale (didn't fill in time, or was
 * never settled), paying the gas from the deployer. `done` means nothing in the
 * contract is waiting on this match any more, so the server can forget it.
 */
export async function refundStale(env: Env, matchId: Hex, joinDeadline: number): Promise<{ done: boolean; hash?: Hex }> {
  const m = await readMatch(env, matchId);
  const now = Date.now() / 1000;
  if (m.status === MatchStatus.Settled) return { done: true };
  if (m.status === MatchStatus.None || (m.status === MatchStatus.Open && m.playerCount === 0)) return { done: now > joinDeadline + 120 };
  if (m.status === MatchStatus.Open && now < Number(m.joinDeadline) + 15) return { done: false };
  if (m.status === MatchStatus.Full && now < Number(m.settleDeadline) + 15) return { done: false };
  if (m.status === MatchStatus.Cancelled) {
    const address = getAddress(env.CONTRACT_ADDRESS);
    const pub = publicClient(env);
    const owed = await Promise.all(m.players.map((p) => pub.readContract({ address, abi: bumperBallsAbi, functionName: "refunded", args: [matchId, p] })));
    if (owed.every(Boolean)) return { done: true };
  }
  const { account, pub, wallet } = deployerClients(env);
  const hash = await deployerTx(async () => {
    const { request } = await pub.simulateContract({ account, address: getAddress(env.CONTRACT_ADDRESS), abi: bumperBallsAbi, functionName: "refundAll", args: [matchId] });
    const h = await wallet.writeContract(request);
    await pub.waitForTransactionReceipt({ hash: h });
    return h;
  });
  return { done: true, hash };
}

/** Sends everything in a deployer address (minus gas) to `to`. Used to take a site down
 *  (the deployer only holds gas money), and to move the old deployer's gas money to the new one. */
export async function sweepDeployer(env: Env, to: Address, key = env.DEPLOYER_KEY): Promise<{ hash: Hex; sent: bigint; from: Address } | null> {
  const { account, pub, wallet } = deployerClients(env, key);
  return deployerTx(async () => {
    const balance = await pub.getBalance({ address: account.address });
    const fees = await pub.estimateFeesPerGas();
    const gas = await pub.estimateGas({ account, to, value: 1n });
    const cost = (gas * 3n * fees.maxFeePerGas) / 2n; // headroom for the L1 data part of the fee
    if (balance <= cost) return null;
    const value = balance - cost;
    const hash = await wallet.sendTransaction({ to, value, gas: (gas * 3n) / 2n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    await pub.waitForTransactionReceipt({ hash });
    return { hash, sent: value, from: account.address };
  });
}
