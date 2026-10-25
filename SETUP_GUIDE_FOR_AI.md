# Bumper Balls: handoff guide for an AI agent

This file is written for you, the AI agent (for example Claude Code) helping the game's new **owner** run Bumper Balls on their own hosting. Read all of it before doing anything. It explains how the game works, how to host it on Render or on a regular website, how to turn on paid play, and how to keep it running.

## How to work: do it yourself, involve the owner only when you must

The owner may not be technical. **Your job is to do every step you can yourself** and keep their part as small as possible.

**You do these yourself, without asking:**

- Read and change the code, build it, run the tests and fix anything that fails.
- Make secrets (`openssl rand -hex 32`) and write settings files.
- Run every server command: installing Node.js and Caddy, unpacking, systemd, firewall, restarts, reading logs.
- Create and push git repositories, and set up deploys.
- Check your own work. Use `curl` against `/healthz` and `/api/config`, read the server log, and open the site in a browser if you have one. Don't ask the owner whether a step worked when you can check it yourself.
- Diagnose and fix errors. Read the logs, search, try again. Only bring an error to the owner when the fix needs something only they can do.
- Pick sensible defaults for anything below that says "default", and tell the owner what you picked.

**Involve the owner only for things that need their identity, money or decision:**

- Signing up for accounts and adding payment methods (GitHub, a VPS provider, Render, Privy). This also covers clicking through sign-in or OAuth screens in their browser and two-factor codes.
- Giving you access you can't get yourself: SSH access to a server, a Render API key, a GitHub login (`gh auth login`), a DNS provider login or API token. Ask them to put keys and tokens in an environment variable or a file only you read, not in chat when that can be avoided.
- Choices that are theirs to make: the game's web address, whether to allow real-money play, which wallet addresses get the house cut.
- Sending ETH (to the deployer address, see Paid play).
- DNS records, if you can't reach their DNS provider yourself.

**When you need the owner,** ask for everything you need in **one message**. List the exact clicks and say exactly what to send back. Then carry on with everything that doesn't depend on their answer.

**Hard rules:**

- Never ask for, accept or store a **private key or seed phrase**. Nothing in this setup needs one. If the owner offers one, tell them not to share it.
- The **Privy App Secret** is never needed. Only the **App ID** goes into the settings.
- Never change `SERVER_SECRET` once paid matches have been played. The contract owner key, the deployer key and the result-signing key all come from it, so keep a private copy (see Settings).
- Run **exactly one** copy of the server, because game rooms live in its memory.
- Get the owner's explicit yes before switching to real money (mainnet), before anything that sends ETH, and before deleting servers or data.
- Don't restart or redeploy while a paid match is being played if you can avoid it. The server refunds an interrupted match on restart, which is safe but annoying for players.

## What's in the package

| Item | What it is |
|---|---|
| `bumper-balls/` (this code) | Full source. Git history isn't included when it comes as a zip. |
| `bumper-balls-server-ready-to-run.zip` | A prebuilt copy of the server and website. It needs only Node.js 20+ to run (`node dist/server.mjs`) and contains `app.js`, `dist/`, `web/dist/` and the `hosting/` files. |

If the owner received the repository itself (a GitHub transfer of `SpamCow/balls`), the code is already in their GitHub account.

## How the game works

**Gameplay:**

- 3D balls on a round platform; the last ball on the platform wins.
- The platform starts shrinking 3 seconds in and stops at its smallest size at 70 seconds. A ball falls once most of it hangs over the edge.
- Controls: WASD or arrow keys, Space to dash. Phones get a touch joystick and a dash button.
- Sounds are made in the browser, and there's a mute button.

**Modes:**

- **Play with friends** (free): a 5-letter room code or invite link. The host presses Start, and bots can fill empty seats.
- **Quick game vs bots** (free).
- **Battle mode** (free with **Battle vs bots** or the Mode picker in a friends room, and also as a paid match). A walled arena with a hole in the middle; everyone has 100 HP. Crates give a random self-aiming weapon (hammer, laser rifle, magnet, spike shell, homing rocket, mines), used with E/Shift or the phone weapon button. The hole grows from 75 s; at 120 s the most HP wins. All tuning numbers are in the `BATTLE` constant in `shared/battle.ts`.
- **Race mode** (free with **Race vs bots** or the Mode picker in a friends room, and also as a paid match). Three laps of a track with no walls: run off the edge and you're put back where you fell about a second later. Rows of ❓ boxes hand out the battle weapons, and running out of HP spins you out briefly instead of knocking you out. First across the line wins; if nobody finishes in 4 minutes, whoever is furthest round wins. The track and tuning are in `shared/race.ts` (`CONTROL` is the track shape, `RACE` the numbers).
- **Paid matches** (optional; turn them on or off with the `PAID_PLAY` setting, see Settings): the player picks classic, battle or race, 1 vs 1, 3 or 4 players, and any entry from 0.0001 ETH up to `MAX_BET_ETH` (default 1). Shortcut buttons offer 0.001, 0.01 and 0.1. Players who pick the same settings land in the same match, and the lobby lists matches still waiting for players. Winner takes the pot minus a 5% house cut.

**Players:**

- They sign in with email or Google through **Privy**, which gives each player a built-in wallet on **Robinhood Chain**. Or they connect their own wallet (MetaMask, Rabby, Coinbase Wallet, or any phone wallet through WalletConnect) in the same sign-in box: entry fees come straight from it and prizes go straight back to it. Stats and usernames belong to the wallet, so signing in by email and by wallet are two separate accounts.
- They deposit ETH to that wallet, play, and cash out to any address from the account panel.
- After signing in they choose a unique username (3 to 16 letters, numbers or `_`).
- Wins, losses and ETH won show in the account panel. The home page has two boards, Top 10 free and Top 10 paid, plus a count of everyone who has ever started a match (signed-in players by wallet, guests once per browser) and of signed-in accounts. Next to each signed-in name (boards and in-match player list) is their net ETH: prizes won minus entry fees paid, in green or red. Entry fees are only on record from 2026-10-24, so totals for players who lost paid matches before then lean high.

**Skins:** players pick a ball skin on the home page, and everyone in the room sees it. Skins are the image files in `web/public/skins/`. There's more under Changing the game.

**One Node.js program does everything.** It serves the web pages, runs the game rooms over WebSockets at 60 ticks a second (the server decides all physics), signs players in, and runs the smart-contract side. That's why it needs hosting that runs Node.js all the time. Plain file hosting can't run it.

**Key files:**

| Path | What |
|---|---|
| `server/index.ts` | HTTP routes, WebSockets, startup |
| `server/room.ts` | Game rooms, matchmaking, results |
| `server/deploy.ts` | Deploys the escrow contract automatically |
| `server/chain.ts` | Chain calls: settle, deployer transactions, sweep |
| `server/fees.ts` | Fee wallet settings (`FEE_RECIPIENT` / `FEE_SPLIT`), kept in sync with the contract |
| `server/profiles.ts` | Usernames and stats in `DATA_DIR/profiles.json`, and the all-time player count in `DATA_DIR/players.txt` |
| `server/auth.ts` | Sign-in tokens |
| `server/env.ts` | Reads settings and derives keys |
| `shared/physics.ts` | The game simulation. `shared/config.ts` holds bet limits and presets, chains and colors |
| `contracts/BumperBalls.sol` | Escrow: signed join tickets, signed results, timeouts, refunds, withdrawals |
| `web/` | The website: Vite + three.js. `web/src/main.ts` is the UI, `render.ts` the 3D view, `privy.ts` sign-in, `sound.ts` the sounds |
| `hosting/` | systemd service, Caddyfile, cPanel start file, example settings |
| `render.yaml`, `Dockerfile` | Render Blueprint (Docker) |
| `.github/workflows/server-zip.yml` | On every push to `main`, builds `bumper-balls-server.zip` and attaches it to the GitHub release `latest` |
| `test/` | `contract.test.ts` (Hardhat) and `e2e.ts` (against a running server) |

**Build and test:**

```bash
npm ci && npm test     # contract tests (10 should pass)
npm run build          # needs about 2.5 GB of RAM
```

`npm run build` puts the website in `web/dist` and the server in `dist/server.mjs`. Start it with `SERVER_SECRET=... node dist/server.mjs`; it serves on `PORT` (default 8787). On a small server, use the ready-to-run zip or the GitHub release instead of building there.

**How paid play works:**

- The server makes its keys from `SERVER_SECRET`.
- When there's no contract yet, the server deploys the escrow on its own. This happens once the **deployer address** (shown on the site and in `/api/config` → `paid.deployer`) holds at least 0.002 ETH on the chosen chain.
- Players pay their entry into the contract with tickets signed by the server.
- After each match the server signs the result and settles it on-chain, paying a small amount of gas from the deployer.
- The server settles each match itself, and the contract sends the prize straight to the winner's wallet and the 5% house cut straight to the fee wallets in that same transaction (see House cut). Nobody has to press Claim; the win screen keeps a small "Claim it now" button only as a backup.
- If a match doesn't fill within 10 minutes, or isn't settled within 30, the server sends every player their stake back by itself within about a minute (`refundAll`, paid from the deployer's gas money). Players can also refund themselves straight from the contract.
- A wallet that refuses an incoming payment (rare, only some smart-contract wallets) gets it as a balance instead, shown as "Ready to withdraw" under **Your matches**. Privy wallets always accept payments.
- Keep some ETH in the deployer (about 0.005). Settling and refunds are paid from it; if it runs dry, winners must press Claim themselves and unfilled matches wait for players to press Refund.
- A **new owner with a new `SERVER_SECRET` gets their own new contract.** That's expected, and the previous owner's contract doesn't matter to them.
- The contract has tests but has **not been professionally audited**, and real-money games are regulated. You must tell the owner both before turning on mainnet.

## Step 1. Get the code into the owner's GitHub (needed for Render; recommended everywhere)

- **If `SpamCow/balls` was transferred to them:** it's already in their account. Clone it.
- **If they got this package as a zip:**
  1. Have them run `gh auth login` once in the terminal you use, or create a token you can use.
  2. Create a **private** repo and push to it:
     ```bash
     git init && git add -A && git commit -m "Bumper Balls" && gh repo create balls --private --source . --push
     ```
  3. Keep the branch named `main`, so the Server zip workflow runs.

## Step 2. Choose the hosting

Ask the owner one question: what hosting and domain do they have, and where should the game live? A subdomain such as `play.theirsite.com` is the default. Then pick:

| They have | Use |
|---|---|
| Nothing, or they want no server to look after | **Render** (Path R) |
| A VPS or cloud server (DigitalOcean, Hetzner, Vultr, Linode, Lightsail, Hostinger VPS, OVH...) | **VPS** (Path V) |
| cPanel hosting with **Setup Node.js App** | **cPanel** (Path C). It works only if the host allows WebSockets, so test it |
| A website builder (Wix, Squarespace, Shopify, Webflow, WordPress.com) or plain FTP hosting | Can't run the server. Host the game with Render or a VPS, then link or embed it from their site (Step 3) |

Whichever path, run one server, over HTTPS (sign-in and wallets need HTTPS).

### Path R. Render.com

Render builds from the owner's GitHub repo using `render.yaml`: Docker, the Starter plan (needed because free instances sleep and lose rooms), one instance and a 1 GB disk at `/data`. It costs about $7 a month plus about $0.25 for the disk. It redeploys on every push to `main`.

**The owner does this part:**

1. Sign in at https://dashboard.render.com with GitHub, and allow Render to see the repo.
2. Click **New → Blueprint**, pick the repo, then **Apply**.
3. Add a payment method if asked.
4. Optional: in Account Settings → API Keys, create a key and give it to you as `RENDER_API_KEY`, so you can manage settings and deploys yourself.

**You do the rest:**

- Wait for the deploy, then check it: `curl https://<service>.onrender.com/healthz` should return `{"ok":true}`, and **Quick game vs bots** should start.
  - With an API key you can watch deploys through the Render API (https://api-docs.render.com), for example `GET /v1/services`, `GET /v1/services/{id}/deploys`.
  - Without one, check the deploy status GitHub shows on the commit: `gh api repos/<owner>/balls/deployments`, then the `statuses` URL.
- Change settings in **Environment** (or `PUT /v1/services/{id}/env-vars/{key}` with the API key). Saving redeploys the service.
- Render generates `SERVER_SECRET` by itself. Ask the owner to copy it from Environment into their password manager, and never change it.
- For their own domain: add it under **Settings → Custom Domains**, and add the `CNAME` record Render shows at their DNS provider. Do that yourself if you have DNS access. Render issues the HTTPS certificate itself.

### Path V. A VPS

**From the owner you need:** an Ubuntu 24.04 server with at least 1 GB of RAM, SSH access to it (an SSH key or login you can use), and an `A` record for the game's subdomain pointing at the server's IP. Add the record yourself if you can reach their DNS. Check it with `dig +short play.theirsite.com`.

**Then run all of this yourself over SSH:**

```bash
sudo apt-get update && sudo apt-get install -y curl unzip ufw debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

**Get the prebuilt server onto the VPS** with one of these:

- Copy `bumper-balls-server-ready-to-run.zip` over with `scp`.
- Download it from the owner's release: `gh release download latest -p bumper-balls-server.zip`. For a private repo this needs `gh` logged in on that machine, or download it locally and `scp` it.
- Build it on a machine with enough RAM.

Then:

```bash
sudo rm -rf /opt/bumper-balls && sudo unzip -q bumper-balls-server*.zip -d /opt   # gives /opt/bumper-balls
sudo cp /opt/bumper-balls/example.env /etc/bumper-balls.env
sudo sed -i "s/^SERVER_SECRET=.*/SERVER_SECRET=$(openssl rand -hex 32)/" /etc/bumper-balls.env
sudo chmod 600 /etc/bumper-balls.env
sudo cp /opt/bumper-balls/bumper-balls.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now bumper-balls
curl -s localhost:8787/healthz       # {"ok":true}
sudo cp /opt/bumper-balls/Caddyfile /etc/caddy/Caddyfile
sudo sed -i "s/play.example.com/play.theirsite.com/" /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable
```

- **Check it** with `curl -sI https://play.theirsite.com` and a Quick game vs bots.
- **Back up the settings file:** give the owner the contents of `/etc/bumper-balls.env` to keep in their password manager.
- **Data** lives in `/var/lib/bumper-balls`: paid matches in play, `profiles.json` with usernames and stats, and `players.txt` behind the "people have played" count.
- **Logs:** `sudo journalctl -u bumper-balls -n 100`. Caddy's are in `journalctl -u caddy`.
- **To change settings,** edit `/etc/bumper-balls.env`, then `sudo systemctl restart bumper-balls`.

### Path C. cPanel with "Setup Node.js App"

Do as much of this as you can through cPanel's terminal or SSH, if the host offers one. Otherwise give the owner the clicks in one message.

1. Put the contents of the ready-to-run zip in `~/bumper-balls`, so that `app.js`, `dist/` and `web/` sit directly inside it. Not in `public_html`. Create `~/bumper-data`.
2. Under **Setup Node.js App → Create Application**, use:
   - Node 20 or newer, Production mode
   - Application root `bumper-balls`
   - Application URL: the game's domain or subdomain
   - Startup file `app.js`
3. Set these environment variables, then Create or Restart the app. Don't set `PORT`, and don't run npm install.
   - `SERVER_SECRET`: 64 random hex characters. Keep a private copy.
   - `CHAIN_ID=46630`
   - `DATA_DIR=/home/<user>/bumper-data`
   - `TRUST_PROXY=1`
4. **Test WebSockets:** Quick game vs bots must start and the balls must move. If the page loads but matches never start, the host blocks WebSockets. Tell the owner and switch to Render or a VPS.
5. Make sure HTTPS is on (**SSL/TLS Status → Run AutoSSL**).

## Step 3. Put it on their website

- **Default:** the game runs at its own address, such as `play.theirsite.com` or the onrender.com address. Add a "Play Bumper Balls" link or button to their main site. If you can edit their site yourself, do it.
- **Or embed it** on a page:

  ```html
  <iframe src="https://play.theirsite.com" style="width:100%;height:80vh;border:0" allow="fullscreen; clipboard-write"></iframe>
  ```

  Free play works inside the frame, but Google sign-in pop-ups often fail there. For paid play, link to the game instead of embedding it.

## Step 4. Sign-in with Privy (always do this)

Players sign in with email or Google through Privy, which also gives each of them a built-in wallet. Do this step even if the owner only wants free play: without it the site has no sign-in, so usernames, stats and the Top players board don't work, and the top-right button says "Sign-in isn't set up".

**The owner does this at https://dashboard.privy.io** (give them all of these steps in one message):

1. Create an app.
2. Under Login methods, turn on **Email**, **Google** and **Wallet** (Wallet lets players connect their own wallet instead).
3. Make sure Ethereum embedded wallets are on.
4. Under App settings → Domains, add the **exact** game address to **Allowed origins**: with `https://`, no slash at the end, and no `www.` unless the site really uses it. For example `https://play.theirsite.com`.
5. Send you the **App ID** (not the secret).

**You:**

- Set `PRIVY_APP_ID` and restart. On Render it's an environment variable; on a VPS or cPanel it goes in the settings file next to `SERVER_SECRET`. The top-right button then says **Sign in**.
- If sign-in fails with "Something went wrong" and the browser console shows `403` from `auth.privy.io`, the Allowed origins entry doesn't exactly match the address in the browser. Privy's own suggestion sometimes adds `www.`, which breaks it.
- Check it yourself: `/api/config` must show `"privyAppId":"<the ID>"`, not `null`. The server log also warns at startup when it's missing.

## Step 5 (optional). Paid play

Skip this if the owner only wants free play. Before you start, tell them three things plainly:

1. Real-money games are regulated in many countries and US states. The site's 18+ and "legal where I live" checkbox is not legal cover.
2. The contract is not audited.
3. Whoever controls the hosting and `SERVER_SECRET` controls who's reported as the winner. They should turn on two-factor sign-in everywhere.

**Terms and privacy pages.** The site ships with `web/public/terms.html` and `web/public/privacy.html`, linked from the home page footer and the real-money dialog. They are templates: every highlighted `[BRACKET]` needs filling in before paid play goes live. In your one message to the owner, ask for:

- their legal name or company
- a contact email
- the country or state whose law applies
- any places to exclude from paid play
- a gambling-help line for their country
- the date

Fill these in yourself, then remove any line they don't want. Tell the owner plainly that a lawyer should review both pages, because you are not one.

### 5a. Testnet first (free), the default

- `CHAIN_ID=46630` is Robinhood Chain testnet. The site shows the deployer address under "Play for testnet ETH".
- Ask the owner to send about 0.005 test ETH there from a faucet (for example https://www.alchemy.com/faucets/robinhood-testnet). The bet buttons unlock within about a minute.
- Play a 0.001 duel in two browsers to check it end to end.

### 5b. Real ETH (Robinhood Chain mainnet)

This needs the owner's explicit yes. Then set:

| Key | Value |
|---|---|
| `CHAIN_ID` | `4663` |
| `ALLOW_MAINNET` | `yes` |
| `FEE_RECIPIENT` | the owner's wallet for the house cut (`0x...`). Ask them for it |
| `FEE_SPLIT` (optional) | split the cut between two wallets: `0xWalletA:69,0xWalletB:31`. The first wallet listed gets the first share |
| `RPC_URL` (recommended) | a dedicated Robinhood Chain mainnet RPC (for example from Alchemy). The default public one is `https://rpc.mainnet.chain.robinhood.com` |

- Restart. The site shows "Play for ETH" and the mainnet deployer address.
- The owner sends about **0.005 ETH on Robinhood Chain mainnet** (not Ethereum mainnet) to the deployer. The contract deploys itself and the buttons unlock.
- Keep about 0.002 ETH in the deployer, since it pays gas for settling matches.
- The explorer is https://robin.etherscan.io.
- If the site shows a message instead of unlocking, follow it: `Set ALLOW_MAINNET=yes`, `Set FEE_RECIPIENT`, or `Send at least 0.002 ETH to the deployer`.

### House cut

The contract sends the house cut straight to the fee wallets in the same transaction that ends each match (the server's settle, or the winner's Claim). Nothing runs separately, nobody collects anything, and no script or key is needed.

- **With `FEE_SPLIT`:** the cut is split between the two wallets in those shares.
- **Without it:** all of it goes to `FEE_RECIPIENT`.
- **Changing it later:** edit the setting and restart. The server updates the contract's fee wallets with `setFee`, and the change applies from the next match that ends.
- **If a wallet can't accept ETH** (a contract wallet that rejects payments), its share is kept in the contract instead of blocking the match. `/#fees` shows any such amount, and that wallet collects it there.
- **Never set up a script that stores the fee wallets' private keys.** It's never needed.

## How many players it handles

Measured with `scripts/load-test.mts` (battle mode, every player steering and using weapons, rounds back to back), on one 2.1 GHz server core:

| Players at once | Server CPU | Memory | Upload from the server |
|---|---|---|---|
| 100 (25 rooms) | 10% of one core | ~100 MB | ~0.8 MB/s |
| 400 (100 rooms) | 40% of one core | ~110 MB | ~3.1 MB/s |

Snapshots kept arriving every ~33 ms (99th percentile 36 ms at 100 players, 43 ms at 400), so the game stayed smooth.

- **Default hosting:**
  - Render Starter (0.5 CPU, 512 MB) or a 1 GB VPS is enough for about 100 to 200 players at once.
  - Above that, move to a bigger plan, such as Render Standard (1 CPU, 2 GB) or a 2-CPU VPS. Change the plan in place; keep **one instance**, because rooms live in memory and a second instance would split them.
  - Run the load test against a copy, not the live site, to check a new plan. The server needs `TRUST_PROXY=1` for the test, so each fake player counts as its own IP. Only keep `TRUST_PROXY=1` on the live site if it sits behind a proxy that sets `X-Forwarded-For` (Render, Caddy and nginx do).
- **Bandwidth:**
  - Each player in a match uses about 8 KB/s, which is roughly 30 MB per hour of play.
  - Check the host's included bandwidth: 100 players playing nonstop for a month would be about 2 TB.
- **The chain side with many paid matches:**
  - Every paid match waiting for players reads the chain every 2.5 s while someone has it open.
  - With dozens waiting at once, the public Robinhood Chain RPC may start limiting requests. Then sign up for a paid RPC (for example Alchemy or QuickNode, if they support Robinhood Chain) and put its URL in `RPC_URL`.
  - Each settled match costs the deployer a little gas, so keep its balance topped up. The site shows its address.
- **Sign-in:** check the Privy plan's monthly active user limit once the player count grows.
- **Per-IP limit:** a single IP can hold 8 game connections at once, so a whole school or office behind one IP could hit it. The limit is `MAX_CONNS_PER_IP` in `server/index.ts`.

## Changing the game

- **Skins:** add PNG, JPG or WEBP files to `web/public/skins/`, then commit and deploy.
  - Names may use letters, numbers, `-` and `_`. The file name becomes the label, so `lava-rock.png` shows as "Lava rock".
  - Images twice as wide as they are tall look best (for example 1024×512), because they wrap around the ball like a world map.
  - Delete a file to remove that skin. The four sample skins can be replaced.
- **Bet sizes, chains and colors:** `shared/config.ts`. **Game feel:** `RULES` in `shared/physics.ts`.
- Run `npm test`, then deploy. A push to `main` redeploys Render and rebuilds the release zip.
  - **VPS:** fetch the new zip, then `sudo rm -rf /opt/bumper-balls && sudo unzip -q <zip> -d /opt && sudo systemctl restart bumper-balls`. Settings and data are kept.
  - **cPanel:** replace the files, then Restart.

## Moving an existing site off Render

Use this when the game already runs on Render and the owner wants it on a VPS or cPanel instead. Done this way, balances, the contract, usernames and stats all carry over.

1. **Copy the settings from Render** (owner, or you with their `RENDER_API_KEY`): Render → the service → Environment. Write down `SERVER_SECRET`, `PRIVY_APP_ID`, `CHAIN_ID`, `ALLOW_MAINNET`, `FEE_RECIPIENT`, `FEE_SPLIT`, `MAX_BET_ETH` and anything else set there.
2. **Use the same `SERVER_SECRET` on the new host.** On a VPS, skip the `openssl rand` line in Path V and put the copied value in `/etc/bumper-balls.env`, with the other settings. A different secret means a different contract, and players' balances would no longer show on the site.
3. **Copy the data:** Render → the service → Shell, then `cat /data/profiles.json` (usernames and stats) and `cat /data/players.txt` (the "people have played" count, if it exists). Save them on the new host under the same names in its `DATA_DIR`, for example on a VPS: `sudo systemctl stop bumper-balls`, copy them to `/var/lib/bumper-balls/`, then `sudo systemctl start bumper-balls` (systemd fixes the file's owner). Skip the other files in `/data`; they only matter for matches in play.
4. **Set up the new host** with Path V or Path C, then check it on its own address before switching (`/healthz`, then `/api/config` should show the **same** contract address as the Render site).
5. **Pick a quiet moment** with no paid matches in play. Only one server may run at a time, because rooms live in memory.
6. **Switch:** add the new address to Privy's Allowed origins (Step 4) if it changes, then point the game's domain at the new host (DNS `A` record for a VPS). On Render, suspend the service (Settings → Suspend) once the new site works. Don't set `SWEEP_DEPLOYER_TO`: the deployer's gas money is shared by both, since it comes from the same secret.
7. **After a few days,** delete the Render service.

### Example: moving to Vultr, paid in crypto

Use this when the owner wants to pay for hosting in crypto. Vultr takes BTC, ETH, USDC, LTC, DOGE and a few others through BitPay. Namecheap sells domains for Bitcoin.

**Which plan:** a Vultr **Cloud Compute, Regular** server running Ubuntu 24.04.
- 4 vCPU / 8 GB, $40 a month with 4 TB of traffic, for growth.
- The 2 vCPU / 4 GB plan, about $20 a month, is plenty to start. Check vultr.com/pricing for the current price.

Either is far more than Render Starter. The game runs on one CPU core, and 100 players used about 10% of a core in testing, so a single fast core is what matters. Adding cores past 2 doesn't add players. Traffic is about 30 MB per player-hour, so 4 TB covers well over 100,000 player-hours a month.

**The owner does this** (give them these steps in one message):
1. Create a Vultr account. Under Billing, choose **Crypto** and add credit, for example $50–100. Vultr may also ask for a card or PayPal to verify a new account.
2. Vultr credit is **prepaid**: when it runs out, the server is suspended. Keep a few months of credit on it and turn on low-balance emails.
3. Deploy a server: **Cloud Compute → Regular**, a location near most players, **Ubuntu 24.04**, the plan above. Add their SSH key, or send you the root password from the server page.
4. Send you the server's IP address and SSH access.
5. Domain: keep the current one, or buy one at Namecheap (Account → Add funds → Bitcoin). In the domain's DNS settings, add an **A record** for the game's subdomain (for example `play`) pointing at the server's IP. If you can reach their DNS yourself, do it for them.

**You:**
1. Follow **Path V** on the new server, but with the moved settings from the list above. Keep the same `SERVER_SECRET`, copy over `profiles.json` and `players.txt`, and use the game's real address in the Caddyfile.
2. Check `https://<game address>/healthz` and `/api/config`. The contract address must match the old site.
3. Switch over at a quiet moment, as in the list above. Then suspend the old Render service, and delete it a few days later.

## Taking the site down

1. Ask players to cash out first. Their built-in wallets are held through Privy, and the site is their easy way to reach them.
2. Nothing to do for the house cut: it was paid out as each match ended.
3. Get the deployer's leftover ETH back: set `SWEEP_DEPLOYER_TO=0x<owner wallet>` and restart. The log shows `sent ... ETH from the deployer ... in 0x...`. Then remove the setting again, unless the site is staying down.
4. Stop the hosting: on Render, Settings → Suspend (or delete); on a VPS, `sudo systemctl disable --now bumper-balls`.
5. Keep `SERVER_SECRET`. Wait 30 minutes after the last match before sweeping the deployer so the server can send back any stakes still waiting. After that, any match still in the contract can be refunded by its players straight from the contract.

## Troubleshooting

| Symptom | Check |
|---|---|
| Site down | `/healthz`; on a VPS, `systemctl status bumper-balls` and the journal. A message about `SERVER_SECRET` means it's missing |
| HTTPS error (VPS) | DNS `A` record, ports 80 and 443 open, `journalctl -u caddy` |
| Page loads, matches never start | WebSockets blocked (cPanel), or more than one server running |
| Sign-in does nothing, or 403 | Privy Allowed origins (Step 4) |
| Bet buttons locked | The message under the paid section. Deployer funding, on the right network |
| Player money looks stuck | The server sends stakes back by itself about a minute after the timeout, if the deployer has gas money (check the log for `sent the stakes back`). Otherwise, under **Your matches** on the home page, press **Refund** or **Withdraw**; it comes straight from the contract |
| Lag | Use the mute button to test whether it's the device. Check the server isn't on a free or sleeping plan |

## Settings

| Variable | Default | Notes |
|---|---|---|
| `SERVER_SECRET` | none (Render generates it) | Required, 32+ random characters. **Never change it, and keep a private copy** |
| `CHAIN_ID` | `46630` testnet | `4663` is mainnet |
| `ALLOW_MAINNET` | not set | `yes` is required for mainnet |
| `FEE_RECIPIENT` | the deployer | Required on mainnet unless `FEE_SPLIT` is set |
| `FEE_SPLIT` | not set | `0xA:69,0xB:31` |
| `MAX_BET_ETH` | `1` | Biggest entry a player can pick |
| `SIGN_IN` | on, but off on Render | `on` shows the Sign in button (Privy), usernames and leaderboards. `off` hides them and also turns paid play off. **Hosting on Render? Set `SIGN_IN=on`** |
| `PAID_PLAY` | on, but off on Render | `on` shows "Play for ETH", `off` hides it and refuses new paid matches (refunds and payouts for earlier matches keep running). **Hosting on Render? Set `PAID_PLAY=on`** |
| `RPC_URL` | public RPC | |
| `PRIVY_APP_ID` | not set | **Required.** Email/Google sign-in and players' built-in wallets |
| `WALLETCONNECT_PROJECT_ID` | not set | Optional. A free project ID from cloud.reown.com for the WalletConnect (phone wallet) option; without it Privy uses its shared one |
| `CONTRACT_ADDRESS` | worked out automatically | Only set if you deployed the contract by hand |
| `DATA_DIR` | `/var/lib/bumper-balls` (VPS), `/data` (Render) | Paid matches in play, plus `profiles.json` and `players.txt`. Back it up |
| `PORT` | `8787` | cPanel sets it itself |
| `TRUST_PROXY` | `1` on a VPS | Set when a proxy (Caddy or the host) sits in front |
| `SWEEP_DEPLOYER_TO` | not set | Shutdown only: sends the deployer's ETH to this wallet on startup |
