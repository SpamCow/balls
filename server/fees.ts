// Where the 5% house cut goes. The escrow sends it straight to the fee wallets
// in the same transaction that settles each match, so nothing has to collect it.
// FEE_SPLIT ("0xBuybackWallet:69,0xOtherWallet:31") splits it between two wallets;
// otherwise all of it goes to FEE_RECIPIENT (or the deployer when that isn't set).
import { getAddress, isAddress, type Address } from "viem";
import { bumperBallsAbi } from "../shared/abi";
import { deployerClients, deployerTx } from "./chain";
import type { Env } from "./env";

export type FeeConfig = { walletA: Address; walletB: Address; shareBps: number };

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Parses "0xA:69,0xB:31". Returns null when unset, or a string describing the problem. */
export function parseSplit(raw: string | undefined): FeeConfig | string | null {
  if (!raw?.trim()) return null;
  const parts = raw.split(",").map((p) => p.trim().split(":").map((x) => x.trim()));
  if (parts.length !== 2 || parts.some((p) => p.length !== 2 || !isAddress(p[0]) || !/^\d+(\.\d+)?$/.test(p[1])))
    return 'FEE_SPLIT should look like "0xFirstWallet:69,0xSecondWallet:31".';
  const [[a, pa], [b, pb]] = parts;
  if (Math.abs(Number(pa) + Number(pb) - 100) > 1e-9) return "FEE_SPLIT percentages must add up to 100.";
  if (getAddress(a) === getAddress(b)) return "FEE_SPLIT needs two different wallets.";
  return { walletA: getAddress(a), walletB: getAddress(b), shareBps: Math.round(Number(pa) * 100) };
}

/** The fee wallets the settings ask for, or a message saying what's wrong with them. */
export function wantedFees(deployer: Address): FeeConfig | string {
  const split = parseSplit(process.env.FEE_SPLIT);
  if (split) return split;
  const one = process.env.FEE_RECIPIENT?.trim();
  if (one && !isAddress(one)) return "FEE_RECIPIENT isn't a wallet address.";
  const w = one ? getAddress(one) : deployer;
  return { walletA: w, walletB: w, shareBps: 10_000 };
}

/** Once the escrow is live: if the fee settings changed since it was deployed, update the contract. */
export async function syncFees(env: Env) {
  const { account, pub, wallet } = deployerClients(env);
  const escrow = getAddress(env.CONTRACT_ADDRESS);
  const want = wantedFees(account.address);
  if (typeof want === "string") return log(want);
  const read = (functionName: "feeRecipient" | "feeRecipient2" | "feeShareBps" | "feeBps") => pub.readContract({ address: escrow, abi: bumperBallsAbi, functionName });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [a, b, share, bps] = await Promise.all([read("feeRecipient"), read("feeRecipient2"), read("feeShareBps"), read("feeBps")]);
      if (getAddress(a as Address) === want.walletA && getAddress(b as Address) === want.walletB && Number(share) === want.shareBps) return;
      await deployerTx(async () => {
        const { request } = await pub.simulateContract({ account, address: escrow, abi: bumperBallsAbi, functionName: "setFee", args: [Number(bps), want.walletA, want.walletB, want.shareBps] });
        await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
      });
      return log(`house cut now goes ${want.shareBps / 100}% to ${want.walletA}${want.walletA === want.walletB ? "" : ` and ${100 - want.shareBps / 100}% to ${want.walletB}`}`);
    } catch (e) {
      log(`couldn't update the fee wallets: ${(e as Error).message.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}
