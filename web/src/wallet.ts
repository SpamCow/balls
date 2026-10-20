// Wallet connection: any EIP-6963 browser wallet (including Robinhood Wallet's
// in-app browser), plus WalletConnect for Robinhood Wallet on a phone.
import { createWalletClient, createPublicClient, custom, http, numberToHex, type Address, type EIP1193Provider, type Chain } from "viem";

export type WalletOption = { id: string; name: string; icon?: string; connect: () => Promise<EIP1193Provider> };

type Announced = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider };
const announced = new Map<string, Announced>();

export function discoverWallets(onChange: () => void) {
  window.addEventListener("eip6963:announceProvider", (e: Event) => {
    const d = (e as CustomEvent<Announced>).detail;
    if (d?.info?.rdns && !announced.has(d.info.rdns)) {
      announced.set(d.info.rdns, d);
      onChange();
    }
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function walletOptions(wcProjectId: string | null, chain: Chain): WalletOption[] {
  const opts: WalletOption[] = [...announced.values()].map((a) => ({
    id: a.info.rdns,
    name: a.info.name,
    icon: a.info.icon,
    connect: async () => a.provider,
  }));
  const injected = (window as any).ethereum as EIP1193Provider | undefined;
  if (!opts.length && injected) opts.push({ id: "injected", name: "Browser wallet", connect: async () => injected });
  if (wcProjectId) {
    opts.push({
      id: "walletconnect",
      name: "Robinhood Wallet (scan QR)",
      connect: async () => {
        const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
        const p = await EthereumProvider.init({
          projectId: wcProjectId,
          chains: [chain.id],
          rpcMap: { [chain.id]: chain.rpcUrls.default.http[0] },
          showQrModal: true,
          metadata: { name: "Bumper Balls", description: "Knock everyone off the platform", url: location.origin, icons: [`${location.origin}/icon.svg`] },
        });
        await p.connect();
        return p as unknown as EIP1193Provider;
      },
    });
  }
  return opts;
}

export async function ensureChain(provider: EIP1193Provider, chain: Chain) {
  const current = Number(await provider.request({ method: "eth_chainId" }));
  if (current === chain.id) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chain.id) }] });
  } catch (e: any) {
    if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(e?.message))) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: numberToHex(chain.id),
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http as unknown as string[],
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
}

export function clients(provider: EIP1193Provider, account: Address, chain: Chain) {
  return {
    wallet: createWalletClient({ account, chain, transport: custom(provider) }),
    pub: createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) }),
  };
}
