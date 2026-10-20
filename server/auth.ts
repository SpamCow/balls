// Wallet sign-in. The player signs a short message with their wallet and gets
// back an HMAC session token bound to their address.
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { publicClient } from "./chain";
import type { Env } from "./env";

const SESSION_TTL = 12 * 3600;
const enc = new TextEncoder();

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function loginMessage(host: string, address: Address, chainId: number, issued: string, nonce: string) {
  return `${host} wants you to sign in to Bumper Balls.\n\nThis only proves you own this wallet. It costs nothing and moves no funds.\n\nAddress: ${address}\nChain ID: ${chainId}\nIssued: ${issued}\nNonce: ${nonce}`;
}

export async function login(env: Env, host: string, body: any): Promise<{ token: string; address: Address } | { error: string }> {
  const { address, issued, nonce, signature } = body ?? {};
  if (typeof address !== "string" || !isAddress(address)) return { error: "bad address" };
  if (typeof nonce !== "string" || !/^[0-9a-f]{16,64}$/.test(nonce)) return { error: "bad nonce" };
  const t = Date.parse(issued);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 5 * 60_000) return { error: "sign-in message expired, try again" };
  const addr = getAddress(address);
  const message = loginMessage(host, addr, Number(env.CHAIN_ID), issued, nonce);
  let ok = false;
  try {
    ok = await verifyMessage({ address: addr, message, signature: signature as Hex });
  } catch {}
  if (!ok) {
    // smart-contract wallets (ERC-1271 / ERC-6492)
    try {
      ok = await publicClient(env).verifyMessage({ address: addr, message, signature: signature as Hex });
    } catch {}
  }
  if (!ok) return { error: "signature check failed" };
  const payload = `${addr}.${Math.floor(Date.now() / 1000) + SESSION_TTL}`;
  return { token: `${payload}.${await hmac(env.SESSION_SECRET, payload)}`, address: addr };
}

export async function verifyToken(env: Env, token: string | null | undefined): Promise<Address | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [addr, exp, mac] = parts;
  if (!isAddress(addr) || !(Number(exp) > Date.now() / 1000)) return null;
  if (!timingSafeEqual(mac, await hmac(env.SESSION_SECRET, `${addr}.${exp}`))) return null;
  return getAddress(addr);
}
