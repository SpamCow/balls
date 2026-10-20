// Deploys the escrow contract from the server's own deployer key the first
// time that key has ETH, so hosting needs no manual deploy step.
// The deployer's first contract always lands at the same address (nonce 0),
// so the server knows its contract address before it exists.
import { createPublicClient, createWalletClient, http, getAddress, formatEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bumperBallsAbi } from "../shared/abi";
import { bumperBallsBytecode } from "../shared/bytecode";
import { rpcUrl, signerAddress } from "./chain";
import type { Env } from "./env";

export type ContractStatus = {
  state: "checking" | "needs-funds" | "deploying" | "live" | "error";
  address: Address;
  deployer?: Address;
  balance?: string;
  message?: string;
};

const FEE_BPS = 500;
const SETTLE_TIMEOUT = 1800n;
const MIN_BALANCE = 2_000_000_000_000_000n; // 0.002 ETH covers the deploy with room to spare

export function ensureContract(env: Env, update: (s: ContractStatus) => void) {
  const address = getAddress(env.CONTRACT_ADDRESS);
  const account = privateKeyToAccount(env.DEPLOYER_KEY as Hex);
  const chainId = Number(env.CHAIN_ID);
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl(env)] } } } as const;
  const pub = createPublicClient({ chain, transport: http(rpcUrl(env)) });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl(env)) });
  // the 5% fee goes here; defaults to the deployer, which the server controls
  const feeRecipient = (process.env.FEE_RECIPIENT ? getAddress(process.env.FEE_RECIPIENT) : account.address) as Address;
  const autoDeploy = chainId !== 4663 || process.env.ALLOW_MAINNET === "yes";
  let busy = false;

  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const code = await pub.getCode({ address });
      if (code && code !== "0x") {
        update({ state: "live", address, deployer: account.address });
        clearInterval(timer);
        return;
      }
      const [balance, nonce] = await Promise.all([pub.getBalance({ address: account.address }), pub.getTransactionCount({ address: account.address })]);
      const base = { address, deployer: account.address, balance: formatEther(balance) };
      if (!autoDeploy) return update({ ...base, state: "error", message: "Set ALLOW_MAINNET=yes to take real ETH." });
      if (chainId === 4663 && !process.env.FEE_RECIPIENT) return update({ ...base, state: "error", message: "Set FEE_RECIPIENT to your wallet before the escrow deploys on mainnet." });
      if (nonce > 0) return update({ ...base, state: "error", message: "The deployer has already sent a transaction, so set CONTRACT_ADDRESS by hand." });
      if (balance < MIN_BALANCE) return update({ ...base, state: "needs-funds", message: `Send at least ${formatEther(MIN_BALANCE)} ETH to the deployer.` });
      update({ ...base, state: "deploying" });
      const hash = await wallet.deployContract({
        abi: bumperBallsAbi,
        bytecode: bumperBallsBytecode,
        args: [account.address, signerAddress(env), feeRecipient, FEE_BPS, SETTLE_TIMEOUT],
      });
      const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rcpt.contractAddress && getAddress(rcpt.contractAddress) !== address) throw new Error(`deployed to unexpected ${rcpt.contractAddress}`);
      console.log(new Date().toISOString(), `deployed escrow ${address} in ${hash}`);
      update({ ...base, state: "live" });
      clearInterval(timer);
    } catch (e) {
      update({ state: "error", address, deployer: account.address, message: (e as Error).message.split("\n")[0] });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(check, 30_000);
  timer.unref();
  check();
}
