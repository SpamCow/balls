// Deploys BumperBalls. Usage:
//   RPC_URL=... DEPLOYER_KEY=0x... SIGNER_ADDRESS=0x... [FEE_RECIPIENT=0x...] [FEE_BPS=500] [SETTLE_TIMEOUT=1800] npx tsx scripts/deploy.ts
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { abi, bytecode } = JSON.parse(fs.readFileSync("build/BumperBalls.json", "utf8"));
const rpc = process.env.RPC_URL!;
const deployer = privateKeyToAccount(process.env.DEPLOYER_KEY as Hex);
const signer = process.env.SIGNER_ADDRESS as Address;
const feeRecipient = (process.env.FEE_RECIPIENT || deployer.address) as Address;
const feeBps = Number(process.env.FEE_BPS || 500);
const settleTimeout = BigInt(process.env.SETTLE_TIMEOUT || 1800);

const pub = createPublicClient({ transport: http(rpc) });
const chainId = await pub.getChainId();
const wallet = createWalletClient({ account: deployer, transport: http(rpc), chain: { id: chainId } as any });
console.log(`chain ${chainId}, deployer ${deployer.address}, balance ${await pub.getBalance({ address: deployer.address })}`);
const hash = await wallet.deployContract({ abi, bytecode, args: [deployer.address, signer, feeRecipient, feeBps, settleTimeout] });
const rcpt = await pub.waitForTransactionReceipt({ hash });
console.log(`BumperBalls deployed at ${rcpt.contractAddress} (tx ${hash})`);
fs.mkdirSync("deployments", { recursive: true });
fs.writeFileSync(`deployments/${chainId}.json`, JSON.stringify({ address: rcpt.contractAddress, tx: hash, signer, feeRecipient, feeBps, settleTimeout: Number(settleTimeout), deployedAt: new Date().toISOString() }, null, 2));
