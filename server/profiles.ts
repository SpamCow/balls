// Player profiles: a unique username and win/loss record per signed-in wallet
// (with Privy, each email/Google login has its own wallet). Kept in one JSON
// file in DATA_DIR; small enough to hold in memory and rewrite on change.
import fs from "node:fs";
import path from "node:path";
import { getAddress, type Address } from "viem";

export type Profile = { name: string | null; wins: number; losses: number; earnedWei: string };

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const RESERVED = /^(admin|mod|moderator|bot\d*|guest\d*|you|player|house|system|bumperballs)$/i;

export function createProfiles(dataDir: string) {
  const file = dataDir ? path.join(dataDir, "profiles.json") : "";
  const byAddr = new Map<string, Profile>();
  try {
    if (file && fs.existsSync(file)) for (const [a, p] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) byAddr.set(a, p as Profile);
  } catch (e) {
    console.error("couldn't read profiles.json:", (e as Error).message);
  }
  const taken = () => new Map([...byAddr].flatMap(([a, p]) => (p.name ? [[p.name.toLowerCase(), a] as const] : [])));

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(byAddr)));
      fs.renameSync(tmp, file);
    }, 500);
  };

  const key = (a: Address) => getAddress(a);
  const get = (a: Address): Profile => byAddr.get(key(a)) ?? { name: null, wins: 0, losses: 0, earnedWei: "0" };

  return {
    get,
    name: (a: Address) => byAddr.get(key(a))?.name ?? null,
    /** Returns an error message, or null when the name was saved. */
    setName(a: Address, raw: unknown): string | null {
      const name = String(raw ?? "").trim();
      if (!NAME_RE.test(name)) return "Usernames are 3 to 16 letters, numbers or underscores.";
      if (RESERVED.test(name)) return "That username is reserved. Try another.";
      const owner = taken().get(name.toLowerCase());
      if (owner && owner !== key(a)) return "That username is taken. Try another.";
      byAddr.set(key(a), { ...get(a), name });
      save();
      return null;
    },
    record(a: Address, won: boolean, prizeWei = 0n) {
      const p = get(a);
      byAddr.set(key(a), { ...p, wins: p.wins + (won ? 1 : 0), losses: p.losses + (won ? 0 : 1), earnedWei: (BigInt(p.earnedWei) + prizeWei).toString() });
      save();
    },
    leaderboard(limit = 10) {
      return [...byAddr.values()]
        .filter((p) => p.name && p.wins + p.losses > 0)
        .sort((x, y) => y.wins - x.wins || x.losses - y.losses)
        .slice(0, limit)
        .map((p) => ({ name: p.name!, wins: p.wins, losses: p.losses }));
    },
  };
}

export type Profiles = ReturnType<typeof createProfiles>;
