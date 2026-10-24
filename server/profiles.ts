// Player profiles: a unique username and win/loss record per signed-in wallet
// (with Privy, each email/Google login has its own wallet). Kept in one JSON
// file in DATA_DIR; small enough to hold in memory and rewrite on change.
import fs from "node:fs";
import path from "node:path";
import { getAddress, type Address } from "viem";

// wins/losses count every match; the free*/paid* pairs split them for the two boards
// (they start at 0 for records made before the split existed)
export type Profile = {
  name: string | null;
  wins: number;
  losses: number;
  earnedWei: string;
  freeWins?: number;
  freeLosses?: number;
  paidWins?: number;
  paidLosses?: number;
  spentWei?: string; // entry fees paid into paid matches (tracked from 2026-10-24; earlier losses aren't on record)
};
type Board = "free" | "paid";

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
  const netOf = (p: Profile) => (BigInt(p.earnedWei) - BigInt(p.spentWei ?? "0")).toString();
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
    record(a: Address, won: boolean, prizeWei = 0n, board: Board = "free", entryWei = 0n) {
      const p = get(a);
      const w = `${board}Wins` as const;
      const l = `${board}Losses` as const;
      byAddr.set(key(a), {
        ...p,
        wins: p.wins + (won ? 1 : 0),
        losses: p.losses + (won ? 0 : 1),
        earnedWei: (BigInt(p.earnedWei) + prizeWei).toString(),
        spentWei: (BigInt(p.spentWei ?? "0") + entryWei).toString(),
        [w]: (p[w] ?? 0) + (won ? 1 : 0),
        [l]: (p[l] ?? 0) + (won ? 0 : 1),
      });
      save();
    },
    leaderboard(board: Board, limit = 10) {
      const w = (p: Profile) => p[`${board}Wins`] ?? 0;
      const l = (p: Profile) => p[`${board}Losses`] ?? 0;
      return [...byAddr.values()]
        .filter((p) => p.name && w(p) + l(p) > 0)
        .sort((x, y) => w(y) - w(x) || l(x) - l(y))
        .slice(0, limit)
        .map((p) => ({ name: p.name!, wins: w(p), losses: l(p), netWei: netOf(p) }));
    },
    /** ETH won minus entry fees paid, in wei (negative when down). */
    net: (a: Address) => netOf(get(a)),
    /** How many signed-in accounts have finished at least one match. */
    accounts: () => [...byAddr.values()].filter((p) => p.wins + p.losses > 0).length,
    /** Signed-in players with any finished match, used to seed the all-time player count. */
    addresses: () => [...byAddr].filter(([, p]) => p.wins + p.losses > 0).map(([a]) => a),
  };
}

export type Profiles = ReturnType<typeof createProfiles>;

// Everyone who has ever started a match: signed-in players by wallet, guests by
// a random id their browser keeps. One id per line in DATA_DIR/players.txt.
export function createPlayerCount(dataDir: string, seed: () => string[]) {
  const file = dataDir ? path.join(dataDir, "players.txt") : "";
  const ids = new Set<string>();
  try {
    if (file && fs.existsSync(file)) for (const id of fs.readFileSync(file, "utf8").split("\n")) id && ids.add(id);
    else for (const a of seed()) ids.add(a.toLowerCase());
    if (file && !fs.existsSync(file) && ids.size) fs.writeFileSync(file, [...ids].join("\n") + "\n");
  } catch (e) {
    console.error("couldn't read players.txt:", (e as Error).message);
  }
  return {
    get total() {
      return ids.size;
    },
    add(list: string[]) {
      const fresh = list.map((id) => id.toLowerCase()).filter((id) => !ids.has(id));
      if (!fresh.length) return;
      for (const id of fresh) ids.add(id);
      if (file) fs.promises.appendFile(file, fresh.join("\n") + "\n").catch((e) => console.error("couldn't save players.txt:", e.message));
    },
  };
}
