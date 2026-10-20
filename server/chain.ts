import { createPublicClient, http, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bumperBallsAbi } from "../shared/abi";
import { CHAINS } from "../shared/config";
import { domain, ticketTypes, resultTypes, type Ticket } from "../shared/eip712";
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
