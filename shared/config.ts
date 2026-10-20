// Match tiers offered in the lobby. The contract doesn't know about tiers: the
// server only signs tickets for these, and the contract binds each match to the
// fee and size in its first ticket.
export type Tier = { id: string; label: string; entryFeeWei: string; maxPlayers: number };

const FEES = [
  ["s", "0.001", "1000000000000000"],
  ["m", "0.01", "10000000000000000"],
  ["l", "0.1", "100000000000000000"],
] as const;

export const TIERS: Tier[] = FEES.flatMap(([id, eth, wei]) => [
  { id: `duel-${id}`, label: `${eth} ETH duel`, entryFeeWei: wei, maxPlayers: 2 },
  { id: `brawl-${id}`, label: `${eth} ETH brawl`, entryFeeWei: wei, maxPlayers: 4 },
]);

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
