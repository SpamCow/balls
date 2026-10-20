// Paid match settings. The contract doesn't know about tiers: the server only
// signs tickets for valid ones, and the contract binds each match to the fee and
// size in its first ticket. A tier is any bet between the limits, for 2, 3 or 4
// players, in classic or battle mode. Players with the same
// settings are put in the same match.
import { formatEther } from "viem";

export type Variant = "classic" | "battle";
export type Tier = { id: string; label: string; entryFeeWei: string; maxPlayers: number; variant: Variant };

export const PRESET_BETS = ["0.001", "0.01", "0.1"];
export const MIN_BET_WEI = 10n ** 14n; // 0.0001 ETH
export const BET_STEP_WEI = 10n ** 12n; // bets are whole multiples of 0.000001 ETH
export const DEFAULT_MAX_BET_ETH = "1";

export function makeTier(variant: Variant, maxPlayers: number, entryFeeWei: bigint): Tier {
  const size = maxPlayers === 2 ? "duel" : maxPlayers === 3 ? "3-way" : "brawl";
  return {
    id: `${variant}-${maxPlayers}-${entryFeeWei}`,
    label: `${formatEther(entryFeeWei)} ETH ${variant === "battle" ? "battle " : ""}${size}`,
    entryFeeWei: entryFeeWei.toString(),
    maxPlayers,
    variant,
  };
}

// the original fixed tiers, so old links and scripts keep working
const LEGACY: Record<string, [number, bigint]> = {
  "duel-s": [2, 10n ** 15n],
  "brawl-s": [4, 10n ** 15n],
  "duel-m": [2, 10n ** 16n],
  "brawl-m": [4, 10n ** 16n],
  "duel-l": [2, 10n ** 17n],
  "brawl-l": [4, 10n ** 17n],
};

/** Reads "classic-2-1000000000000000" (variant-players-wei). Returns a reason string if it isn't allowed. */
export function parseTier(id: string, maxBetWei: bigint): Tier | string {
  if (LEGACY[id]) return makeTier("classic", ...LEGACY[id]);
  const m = /^(classic|battle)-([234])-([1-9][0-9]{0,30})$/.exec(id);
  if (!m) return "Pick classic or battle, 2, 3 or 4 players, and a bet.";
  const wei = BigInt(m[3]);
  if (wei < MIN_BET_WEI) return `The smallest bet is ${formatEther(MIN_BET_WEI)} ETH.`;
  if (wei > maxBetWei) return `The biggest bet is ${formatEther(maxBetWei)} ETH.`;
  if (wei % BET_STEP_WEI !== 0n) return "Bets can have at most 6 decimal places.";
  return makeTier(m[1] as Variant, Number(m[2]), wei);
}

export const JOIN_WINDOW_SEC = 10 * 60; // seats must fill within this
export const TICKET_TTL_SEC = 3 * 60;
export const COUNTDOWN_SEC = 5;

export const CHAINS: Record<number, { name: string; rpc: string; explorer: string }> = {
  46630: {
    name: "Robinhood Chain Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
  },
  4663: {
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robin.etherscan.io",
  },
  31337: { name: "Local devnet", rpc: "http://127.0.0.1:8545", explorer: "" },
};

export const COLORS = ["#ff4d6d", "#4dabff", "#ffd23f", "#3ddc97"];
