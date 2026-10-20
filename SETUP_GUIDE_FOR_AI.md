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
- **Paid matches** (optional): 0.001, 0.01 or 0.1 ETH entry, as a 2-player duel or a 4-player brawl. Winner takes the pot minus a 5% house cut.

**Players:**

- They sign in with email or Google through **Privy**, which gives each player a built-in wallet on **Robinhood Chain**.
- They deposit ETH to that wallet, play, and cash out to any address from the account panel.
- After signing in they choose a unique username (3 to 16 letters, numbers or `_`).
- Wins, losses and ETH won show in the account panel, and the home page has a Top players board.

**Skins:** players pick a ball skin on the home page, and everyone in the room sees it. Skins are the image files in `web/public/skins/`. There's more under Changing the game.

**One Node.js program does everything.** It serves the web pages, runs the game rooms over WebSockets at 60 ticks a second (the server decides all physics), signs players in, and runs the smart-contract side. That's why it needs hosting that runs Node.js all the time. Plain file hosting can't run it.

**Key files:**

| Path | What |
|---|---|
| `server/index.ts` | HTTP routes, WebSockets, startup |
| `server/room.ts` | Game rooms, matchmaking, results |
| `server/deploy.ts` | Deploys the escrow contract automatically |
| `server/chain.ts` | Chain calls: settle, deployer transactions, sweep |
| `server/fees.ts` | House-cut split |
| `server/profiles.ts` | Usernames and stats, stored in `DATA_DIR/profiles.json` |
| `server/auth.ts` | Sign-in tokens |
| `server/env.ts` | Reads settings and derives keys |
| `shared/physics.ts` | The game simulation. `shared/config.ts` holds bet tiers, chains and colors |
| `contracts/BumperBalls.sol` | Escrow: signed join tickets, signed results, timeouts, refunds, withdrawals |
| `contracts/FeeSplitter.sol` | Splits the house cut between two wallets |
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
- The winner presses Claim to receive the pot. The 5% house cut stays in the contract until it's collected (see House cut).
- If a match doesn't fill within 10 minutes, or isn't settled within 30, every player can refund themselves straight from the contract.
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
- **Data** lives in `/var/lib/bumper-balls`: paid matches in play, and `profiles.json` with usernames and stats.
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

## Step 4 (optional). Paid play

Skip this if the owner only wants free play. Before you start, tell them three things plainly:

1. Real-money games are regulated in many countries and US states. The site's 18+ and "legal where I live" checkbox is not legal cover.
2. The contract is not audited.
3. Whoever controls the hosting and `SERVER_SECRET` controls who's reported as the winner. They should turn on two-factor sign-in everywhere.

### 4a. Privy sign-in

**The owner does this at https://dashboard.privy.io** (give them all of these steps in one message):

1. Create an app.
2. Under Login methods, turn on **Email** and **Google**.
3. Make sure Ethereum embedded wallets are on.
4. Under App settings → Domains, add the **exact** game address to **Allowed origins**: with `https://`, no slash at the end, and no `www.` unless the site really uses it. For example `https://play.theirsite.com`.
5. Send you the **App ID** (not the secret).

**You:**

- Set `PRIVY_APP_ID` and restart. The top-right button then says **Sign in**.
- If sign-in fails with "Something went wrong" and the browser console shows `403` from `auth.privy.io`, the Allowed origins entry doesn't exactly match the address in the browser. Privy's own suggestion sometimes adds `www.`, which breaks it.

### 4b. Testnet first (free), the default

- `CHAIN_ID=46630` is Robinhood Chain testnet. The site shows the deployer address under "Play for testnet ETH".
- Ask the owner to send about 0.005 test ETH there from a faucet (for example https://www.alchemy.com/faucets/robinhood-testnet). The bet buttons unlock within about a minute.
- Play a 0.001 duel in two browsers to check it end to end.

### 4c. Real ETH (Robinhood Chain mainnet)

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
- Keep about 0.002 ETH in the deployer, since it pays gas for settling matches and fee payouts.
- The explorer is https://robin.etherscan.io.
- If the site shows a message instead of unlocking, follow it: `Set ALLOW_MAINNET=yes`, `Set FEE_RECIPIENT`, or `Send at least 0.002 ETH to the deployer`.

### House cut

- **With `FEE_SPLIT` (recommended):** the server deploys a FeeSplitter once and points the house cut at it. Whenever at least 0.002 ETH has built up, it pays both wallets automatically. To pay out sooner, the owner double-clicks the script in `tools/collect-fees/` (Mac `.command` or Windows `.bat`; put the game's address in `site.txt` first). It holds no keys: it asks the server to run the payout, and the splitter can only ever pay those two wallets. The `/#fees` page also has a **Pay out now** button, but it's no longer linked from the home page. Never set up a script that stores the fee wallets' private keys.
- **Without `FEE_SPLIT`:** the cut is held in the contract for `FEE_RECIPIENT`, and only that wallet can collect it. Either open `/#fees`, connect that wallet with MetaMask or Rabby and press Collect, or skip the site entirely: from that wallet, send 0 ETH to the contract address with hex data `0x3ccfd60b` (that's `withdraw()`). MetaMask sometimes shows a "drainer" warning for a new site on a shared address like onrender.com. The hex-data route avoids it.

## Changing the game

- **Skins:** add PNG, JPG or WEBP files to `web/public/skins/`, then commit and deploy.
  - Names may use letters, numbers, `-` and `_`. The file name becomes the label, so `lava-rock.png` shows as "Lava rock".
  - Images twice as wide as they are tall look best (for example 1024×512), because they wrap around the ball like a world map.
  - Delete a file to remove that skin. The four sample skins can be replaced.
- **Bet sizes, chains and colors:** `shared/config.ts`. **Game feel:** `RULES` in `shared/physics.ts`.
- Run `npm test`, then deploy. A push to `main` redeploys Render and rebuilds the release zip.
  - **VPS:** fetch the new zip, then `sudo rm -rf /opt/bumper-balls && sudo unzip -q <zip> -d /opt && sudo systemctl restart bumper-balls`. Settings and data are kept.
  - **cPanel:** replace the files, then Restart.

## Taking the site down

1. Ask players to cash out first. Their built-in wallets are held through Privy, and the site is their easy way to reach them.
2. Collect or pay out the house cut (see House cut).
3. Get the deployer's leftover ETH back: set `SWEEP_DEPLOYER_TO=0x<owner wallet>` and restart. The log shows `sent ... ETH from the deployer ... in 0x...`. Then remove the setting again, unless the site is staying down.
4. Stop the hosting: on Render, Settings → Suspend (or delete); on a VPS, `sudo systemctl disable --now bumper-balls`.
5. Keep `SERVER_SECRET`. Any match still in the contract can be refunded by its players straight from the contract after the timeout.

## Troubleshooting

| Symptom | Check |
|---|---|
| Site down | `/healthz`; on a VPS, `systemctl status bumper-balls` and the journal. A message about `SERVER_SECRET` means it's missing |
| HTTPS error (VPS) | DNS `A` record, ports 80 and 443 open, `journalctl -u caddy` |
| Page loads, matches never start | WebSockets blocked (cPanel), or more than one server running |
| Sign-in does nothing, or 403 | Privy Allowed origins (4a) |
| Bet buttons locked | The message under the paid section. Deployer funding, on the right network |
| Player money looks stuck | Under **Your matches** on the home page, press **Refund** once the timeout has passed. It comes straight from the contract |
| Lag | Use the mute button to test whether it's the device. Check the server isn't on a free or sleeping plan |

## Settings

| Variable | Default | Notes |
|---|---|---|
| `SERVER_SECRET` | none (Render generates it) | Required, 32+ random characters. **Never change it, and keep a private copy** |
| `CHAIN_ID` | `46630` testnet | `4663` is mainnet |
| `ALLOW_MAINNET` | not set | `yes` is required for mainnet |
| `FEE_RECIPIENT` | the deployer | Required on mainnet |
| `FEE_SPLIT` | not set | `0xA:69,0xB:31` |
| `RPC_URL` | public RPC | |
| `PRIVY_APP_ID` | not set | Turns on email/Google sign-in |
| `WALLETCONNECT_PROJECT_ID` | not set | Only used without Privy |
| `CONTRACT_ADDRESS` | worked out automatically | Only set if you deployed the contract by hand |
| `DATA_DIR` | `/var/lib/bumper-balls` (VPS), `/data` (Render) | Paid matches in play, plus `profiles.json`. Back it up |
| `PORT` | `8787` | cPanel sets it itself |
| `TRUST_PROXY` | `1` on a VPS | Set when a proxy (Caddy or the host) sits in front |
| `SWEEP_DEPLOYER_TO` | not set | Shutdown only: sends the deployer's ETH to this wallet on startup |
