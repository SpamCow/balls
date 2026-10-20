// EIP-712 typed data shared by the game server (signing) and tests.
import type { Address, Hex } from "viem";

export const domain = (chainId: number, verifyingContract: Address) =>
  ({ name: "BumperBalls", version: "1", chainId, verifyingContract }) as const;

export const ticketTypes = {
  JoinTicket: [
    { name: "matchId", type: "bytes32" },
    { name: "player", type: "address" },
    { name: "entryFee", type: "uint256" },
    { name: "maxPlayers", type: "uint8" },
    { name: "joinDeadline", type: "uint64" },
    { name: "ticketExpiry", type: "uint64" },
  ],
} as const;

export const resultTypes = {
  MatchResult: [
    { name: "matchId", type: "bytes32" },
    { name: "winner", type: "address" },
  ],
} as const;

export type Ticket = {
  matchId: Hex;
  player: Address;
  entryFee: bigint;
  maxPlayers: number;
  joinDeadline: bigint;
  ticketExpiry: bigint;
};

export enum MatchStatus {
  None,
  Open,
  Full,
  Settled,
  Cancelled,
}
