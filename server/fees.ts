// Optional house-cut split. With FEE_SPLIT set (for example
// "0xBuybackWallet:69,0xOtherWallet:31") the server deploys a FeeSplitter and
// makes it the escrow's fee recipient, then pays it out to the two wallets now
// and then. Without FEE_SPLIT the whole cut stays with FEE_RECIPIENT.
import { getAddress, isAddress, formatEther, type Address } from "viem";
import { bumperBallsAbi } from "../shared/abi";
import { feeSplitterAbi, feeSplitterBytecode } from "../shared/splitter";
import { deployerClients, deployerTx } from "./chain";
import type { Env } from "./env";

export type FeeSplit = { walletA: Address; walletB: Address; bpsA: number };
export type FeeStatus = {
  mode: "single" | "split" | "setting-up" | "error";
  recipient?: Address;
  split?: { wallet: Address; percent: number }[];
  pending?: string;
  /** Fees credited to the old single fee wallet before the split, still to collect by hand. */
  earlier?: { wallet: Address; owed: string };
  message?: string;
};

const AUTO_PAYOUT_WEI = 2_000_000_000_000_000n; // pay out once 0.002 ETH has built up

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Parses "0xA:69,0xB:31". Returns null when unset, or a string describing the problem. */
export function parseSplit(raw: string | undefined): FeeSplit | string | null {
  if (!raw?.trim()) return null;
  const parts = raw.split(",").map((p) => p.trim().split(":").map((x) => x.trim()));
  if (parts.length !== 2 || parts.some((p) => p.length !== 2 || !isAddress(p[0]) || !/^\d+(\.\d+)?$/.test(p[1])))
    return 'FEE_SPLIT should look like "0xFirstWallet:69,0xSecondWallet:31".';
  const [[a, pa], [b, pb]] = parts;
  if (Math.abs(Number(pa) + Number(pb) - 100) > 1e-9) return "FEE_SPLIT percentages must add up to 100.";
  if (getAddress(a) === getAddress(b)) return "FEE_SPLIT needs two different wallets.";
  return { walletA: getAddress(a), walletB: getAddress(b), bpsA: Math.round(Number(pa) * 100) };
}

export function createFees(env: Env) {
  const { account, pub, wallet } = deployerClients(env);
  const escrow = getAddress(env.CONTRACT_ADDRESS);
  const parsed = parseSplit(process.env.FEE_SPLIT);
  let splitter: Address | null = null;
  let status: FeeStatus = { mode: "single" };
  let lastManual = 0;

  async function currentRecipient() {
    return (await pub.readContract({ address: escrow, abi: bumperBallsAbi, functionName: "feeRecipient" })) as Address;
  }

  async function matches(addr: Address, s: FeeSplit) {
    try {
      const [a, b, bps] = await Promise.all(
        (["walletA", "walletB", "bpsA"] as const).map((fn) => pub.readContract({ address: addr, abi: feeSplitterAbi, functionName: fn })),
      );
      return getAddress(a as Address) === s.walletA && getAddress(b as Address) === s.walletB && Number(bps) === s.bpsA;
    } catch {
      return false; // not a splitter
    }
  }

  /** Called once the escrow is live. */
  async function setup() {
    if (parsed === null) {
      status = { mode: "single", recipient: await currentRecipient().catch(() => undefined) };
      return;
    }
    if (typeof parsed === "string") {
      status = { mode: "error", message: parsed };
      return log(parsed);
    }
    status = { mode: "setting-up" };
    for (let attempt = 0; ; attempt++) {
      try {
        const now = await currentRecipient();
        if (await matches(now, parsed)) splitter = now;
        else {
          splitter = await deployerTx(async () => {
            const hash = await wallet.deployContract({ abi: feeSplitterAbi, bytecode: feeSplitterBytecode, args: [escrow, parsed.walletA, parsed.walletB, parsed.bpsA] });
            const addr = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
            log(`fee splitter deployed at ${addr}`);
            const bps = (await pub.readContract({ address: escrow, abi: bumperBallsAbi, functionName: "feeBps" })) as number;
            const { request } = await pub.simulateContract({ account, address: escrow, abi: bumperBallsAbi, functionName: "setFee", args: [bps, addr] });
            await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
            log(`house cut now goes to the splitter (${parsed.bpsA / 100}% / ${100 - parsed.bpsA / 100}%)`);
            return addr;
          });
        }
        await refresh();
        return;
      } catch (e) {
        const msg = (e as Error).message.split("\n")[0];
        status = { mode: "error", message: `Couldn't set up the fee split: ${msg}` };
        log(status.message);
        if (attempt >= 5) return;
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
  }

  async function pendingWei() {
    if (!splitter) return 0n;
    return (await pub.readContract({ address: splitter, abi: feeSplitterAbi, functionName: "pending" })) as bigint;
  }

  async function refresh() {
    if (!splitter || typeof parsed !== "object" || !parsed) return;
    status = {
      mode: "split",
      recipient: splitter,
      split: [
        { wallet: parsed.walletA, percent: parsed.bpsA / 100 },
        { wallet: parsed.walletB, percent: 100 - parsed.bpsA / 100 },
      ],
      pending: formatEther(await pendingWei()),
    };
    const old = process.env.FEE_RECIPIENT && isAddress(process.env.FEE_RECIPIENT) ? getAddress(process.env.FEE_RECIPIENT) : null;
    if (old && old !== splitter) {
      const owed = (await pub.readContract({ address: escrow, abi: bumperBallsAbi, functionName: "balances", args: [old] })) as bigint;
      if (owed > 0n) status.earlier = { wallet: old, owed: formatEther(owed) };
    }
  }

  async function payout(): Promise<string | null> {
    if (!splitter) return null;
    if ((await pendingWei()) === 0n) return null;
    const hash = await deployerTx(async () => {
      const { request } = await pub.simulateContract({ account, address: splitter!, abi: feeSplitterAbi, functionName: "payout", args: [] });
      const h = await wallet.writeContract(request);
      await pub.waitForTransactionReceipt({ hash: h });
      return h;
    });
    log(`house cut paid out in ${hash}`);
    await refresh();
    return hash;
  }

  return {
    setup,
    status: () => status,
    /** After each settled match: pay out once enough has built up. */
    async afterSettle() {
      try {
        if (splitter && (await pendingWei()) >= AUTO_PAYOUT_WEI) await payout();
        else await refresh();
      } catch (e) {
        log(`fee payout failed: ${(e as Error).message.split("\n")[0]}`);
      }
    },
    /** The "Pay out now" button: at most once a minute for everyone. */
    async manualPayout(): Promise<{ status: number; body: unknown }> {
      if (!splitter) return { status: 400, body: { error: "There's no fee split set up." } };
      if (Date.now() - lastManual < 60_000) return { status: 429, body: { error: "A payout just ran. Try again in a minute." } };
      lastManual = Date.now();
      try {
        const hash = await payout();
        return { status: 200, body: { hash, ...status } };
      } catch (e) {
        return { status: 500, body: { error: (e as Error).message.split("\n")[0] } };
      }
    },
  };
}

export type Fees = ReturnType<typeof createFees>;
