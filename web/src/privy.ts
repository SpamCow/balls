// Privy sign-in: email or Google creates a built-in wallet for the player.
// Loaded only when the server has a PRIVY_APP_ID, so the rest of the site
// stays plain TypeScript.
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { getAddress, type Address, type Chain, type EIP1193Provider } from "viem";

export type PrivyState = {
  ready: boolean;
  signedIn: boolean;
  label: string | null; // email or Google address, for the account panel
  account: Address | null;
  provider: EIP1193Provider | null;
  builtIn: boolean; // the wallet Privy made for them, not one they brought
};

export type PrivyApi = { login: () => void; logout: () => Promise<void> };

export function mountPrivy(appId: string, chain: Chain, onChange: (s: PrivyState) => void): Promise<PrivyApi> {
  return new Promise((resolve, reject) => {
    let lastKey = "";
    let done = false;
    // Privy reports setup problems (wrong app ID, origin not allowed) only on the
    // console, so remember the last one to show the player instead of a dead button.
    let lastProblem = "";
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      if (/privy|origin|app id|app_id/i.test(text)) lastProblem = text.slice(0, 300);
      consoleError(...args);
    };
    const fail = (why: string) => {
      if (done) return;
      done = true;
      reject(new Error(why));
    };
    const timer = setTimeout(
      () => fail(`Sign-in didn't finish loading${lastProblem ? `: ${lastProblem}` : ". Check PRIVY_APP_ID, and that this exact address (no slash at the end) is in the Privy app's Allowed origins."}`),
      15000,
    );
    function Bridge() {
      const { ready, authenticated, user, login, logout } = usePrivy();
      const { wallets, ready: walletsReady } = useWallets();
      useEffect(() => {
        if (!ready || done) return;
        done = true;
        clearTimeout(timer);
        resolve({ login, logout });
      }, [ready, login, logout]);
      useEffect(() => {
        if (!ready || !walletsReady) return;
        const linked = new Set((user?.linkedAccounts ?? []).flatMap((a: any) => (a.type === "wallet" && a.address ? [a.address.toLowerCase()] : [])));
        const mine = wallets.filter((w) => linked.has(w.address.toLowerCase()));
        const w: ConnectedWallet | undefined = mine.find((x) => x.walletClientType === "privy");
        const label = user?.email?.address ?? user?.google?.email ?? null;
        const key = `${authenticated}|${w?.address}|${label}`;
        if (key === lastKey) return;
        lastKey = key;
        if (!authenticated || !w) return onChange({ ready: true, signedIn: authenticated, label, account: null, provider: null, builtIn: false });
        (async () => {
          await w.switchChain(chain.id).catch(() => {});
          const provider = (await w.getEthereumProvider()) as unknown as EIP1193Provider;
          onChange({ ready: true, signedIn: true, label, account: getAddress(w.address), provider, builtIn: w.walletClientType === "privy" });
        })();
      }, [ready, walletsReady, authenticated, user, wallets]);
      return null;
    }
    const el = document.createElement("div");
    document.body.append(el);
    createRoot(el, { onUncaughtError: (e) => fail(`Sign-in couldn't start: ${e instanceof Error ? e.message : String(e)}`) }).render(
      createElement(
        PrivyProvider,
        {
          appId,
          config: {
            loginMethods: ["email", "google"],
            appearance: { theme: "dark", accentColor: "#ff3d7f", landingHeader: "Sign in to play", walletChainType: "ethereum-only" },
            embeddedWallets: { ethereum: { createOnLogin: "all-users" }, showWalletUIs: true },
            defaultChain: chain,
            supportedChains: [chain],
          },
          children: createElement(Bridge),
        },
      ),
    );
  });
}
