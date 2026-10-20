// Server settings, read once from the environment. Keys are derived from one
// SERVER_SECRET so a host (Render) can generate it and nothing has to be pasted.
import { keccak256, toHex, getContractAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";

export interface Env {
  CHAIN_ID: string;
  RPC_URL?: string;
  CONTRACT_ADDRESS: string;
  WALLETCONNECT_PROJECT_ID?: string;
  RESULT_SIGNER_KEY: string;
  SESSION_SECRET: string;
  DEPLOYER_KEY: string;
  /** Deployers of earlier contract versions, kept only to move their leftover gas money over. */
  OLD_DEPLOYER_KEYS: string[];
  /** Earlier contract versions, so players can still withdraw anything left in them. */
  OLD_CONTRACTS: string[];
  POLL_MS?: string;
}

export function loadEnv(e = process.env): Env {
  const secret = e.SERVER_SECRET || (e.NODE_ENV === "production" ? "" : "dev-only-secret");
  if (!secret || secret.length < 16) throw new Error("Set SERVER_SECRET (16+ characters) in the environment.");
  const derive = (label: string) => keccak256(toHex(`bumper-balls:${label}:${secret}`));
  // A new contract version gets a fresh deployer key, so its contract is again the
  // deployer's first one and lands at a fixed address.
  const deployerKey = (e.DEPLOYER_KEY as `0x${string}`) || derive("deployer-v3");
  const deployer = privateKeyToAccount(deployerKey).address;
  return {
    CHAIN_ID: e.CHAIN_ID || "46630",
    RPC_URL: e.RPC_URL || undefined,
    // the first contract the deployer creates always lands at this address
    CONTRACT_ADDRESS: e.CONTRACT_ADDRESS || getContractAddress({ from: deployer, nonce: 0n }),
    WALLETCONNECT_PROJECT_ID: e.WALLETCONNECT_PROJECT_ID || undefined,
    RESULT_SIGNER_KEY: e.RESULT_SIGNER_KEY || derive("signer"),
    SESSION_SECRET: e.SESSION_SECRET || createHash("sha256").update(`bumper-balls:session:${secret}`).digest("hex"),
    DEPLOYER_KEY: deployerKey,
    OLD_DEPLOYER_KEYS: e.DEPLOYER_KEY ? [] : [derive("deployer"), derive("deployer-v2")],
    OLD_CONTRACTS: e.DEPLOYER_KEY ? [] : [derive("deployer-v2"), derive("deployer")].map((k) => getContractAddress({ from: privateKeyToAccount(k).address, nonce: 0n })),
    POLL_MS: e.POLL_MS,
  };
}
