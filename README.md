# Bumper Balls

Online multiplayer Bumper Balls with pay-to-play matches on Robinhood Chain (Arbitrum-based Ethereum L2).
Everyone pays the same entry fee into an escrow contract; the last ball on the shrinking platform wins the pot minus a 5% fee.

## Layout

| Path | What |
|---|---|
| `contracts/BumperBalls.sol` | Escrow contract: signed join tickets, signed results, timeouts, refunds, pull payments |
| `shared/` | Physics simulation, EIP-712 types, tiers/chain config, generated ABI and bytecode |
| `server/` | Node server: static site, wallet sign-in, matchmaking, authoritative game rooms, escrow auto-deploy |
| `web/` | Vite + three.js client: 3D arena, keyboard/touch controls, EIP-6963 wallets + optional WalletConnect |
| `demo/` | Single-file offline demo (solo vs bots, two players on one keyboard) |
| `test/contract.test.ts` | Contract tests on a local Hardhat EVM |
| `test/e2e.ts` | Paid match, practice match and friends rooms against a running server |

## Ways to play

- **Play with friends (free):** create a room, send the 5-character code or invite link, and the host presses Start. Empty seats can be filled with bots.
- **Quick game vs bots (free):** drops you into a practice match; anyone who joins in the first few seconds plays too.
- **ETH matches:** 2- or 4-player matches with an entry fee held in the escrow contract (testnet by default, real ETH on mainnet when enabled).

The platform starts shrinking 3 seconds in and keeps closing until 70 seconds, so every match ends. A ball drops once most of it hangs past the rim.

## How a paid match works

1. Player signs a free sign-in message; the server returns a session token bound to their address.
2. Player picks a tier; the lobby returns a **join ticket** signed by the server for the current open match (matchId, player, fee, size, deadlines).
3. Player calls `join(...)` with the entry fee. The first ticket fixes the match's fee, size, fee bps and signer; later tickets must match.
4. When all seats are paid on-chain (`MatchFull`), the room counts down and runs the physics at 60 Hz. Clients only send steering input.
5. The room signs `MatchResult(matchId, winner)` (EIP-712, bound to chain + contract). The winner calls `claim`, which settles and withdraws in one transaction.

## Safety properties (tested)

- Winner must be one of the match's paid players; results are bound to one match, chain and contract.
- Fee (≤10% hard cap) and signer are snapshotted per match, so admin changes can't touch running matches.
- Match not full by its join deadline (10 min), or not settled within the settle timeout (30 min): every player can `refund` with no one's permission.
- `leave` refunds instantly before a match fills. Pausing only blocks new joins.
- Server restart mid-match → the room signs a "no winner" result so everyone is refunded immediately.
- Nobody touched their controls → no winner, everyone refunded.
- Server-side: rate-limited, size-capped, sanitized inputs; one connection per wallet; HMAC session tokens.

Trust assumption: players trust the game server to report the true winner (it can't send funds anywhere else).

## Develop

```bash
npm install
npm test                                   # contract tests
npx hardhat node &                         # local chain on :8545
SERVER_SECRET=dev-secret-0123456789 CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 npm run build && npm start
# send local ETH to the deployer shown at /api/config; the server deploys the escrow itself
npx tsx test/e2e.ts
```

## Hosting (Render)

`render.yaml` is a Blueprint: in Render choose **New → Blueprint** and pick this repo. Render generates `SERVER_SECRET`; the server derives its sign-in secret, result-signing key and deployer key from it.

Free play works as soon as it's up. To open paid matches, send about 0.005 Robinhood Chain testnet ETH to the deployer address the site shows under "Play for testnet ETH". The server then deploys the escrow contract itself (testnet only) and the paid tiers unlock.

| Variable | Default | |
|---|---|---|
| `SERVER_SECRET` | (required in production) | 16+ characters. Changing it changes every key, so keep it fixed |
| `CHAIN_ID` | `46630` | `4663` is Robinhood Chain mainnet: no auto-deploy there unless `ALLOW_MAINNET=yes` |
| `ALLOW_MAINNET` | none | must be `yes` before the escrow deploys on mainnet |
| `RPC_URL` | public RPC for the chain | |
| `CONTRACT_ADDRESS` | deployer's first contract | set only if you deployed the escrow yourself |
| `FEE_RECIPIENT` | deployer | your wallet for the 5% fee, fixed when the escrow deploys |
| `WALLETCONNECT_PROJECT_ID` | none | enables QR connect for Robinhood Wallet on phones |
| `DATA_DIR` | none | where paid matches in play are remembered across restarts |

Mainnet means real-money play, which is regulated in many places. To turn it on set `CHAIN_ID=4663`, `ALLOW_MAINNET=yes` and `FEE_RECIPIENT`, then fund the deployer. Step-by-step owner instructions are in `SETUP_GUIDE_FOR_AI.md`.
