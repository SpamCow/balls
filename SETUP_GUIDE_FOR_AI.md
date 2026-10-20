# Bumper Balls: setup guide for an AI assistant

You are helping the **owner** of this game put it on their own website. The owner may not be technical. Walk them through the steps below one at a time, in plain language, and wait for them to confirm each step before moving on. Ask them to paste what they see (screens, error text, addresses) when something doesn't match this guide.

Do not invent extra steps, and do not ask the owner for any private key or seed phrase. Nothing in this setup needs one.

## What the owner is getting

- A browser game: 3D balls on a shrinking platform, last one on wins. Works on desktop (WASD/arrows, Space to dash) and phones (touch joystick).
- Free modes: **Play with friends** (5-letter room code or invite link, host presses Start, bots can fill empty seats) and **Quick game vs bots**.
- Paid mode (optional): players sign in with email or Google (through **Privy**), which gives each of them a built-in game wallet on **Robinhood Chain**. They send ETH to that wallet, then pay an entry of 0.001, 0.01 or 0.1 ETH into a smart contract. Duels (2 players) or brawls (4 players). Winner takes the pot minus a 5% fee that goes to the owner's wallet. Players can always get their entry back from the contract if a match never fills (10 min) or never finishes (30 min), and can cash their balance out to any address from the wallet panel.
- It is one Node.js program that serves the game's web pages, runs the game rooms over live WebSocket connections, and sets up the smart contract by itself. It has to keep running all the time, so it needs hosting that can run Node.js, not just store web files.

## What the owner needs

| Need | Why | Cost |
|---|---|---|
| A GitHub account | Holds their copy of the code | Free |
| Hosting that runs Node.js (see Step 2) | Runs the game server | A small VPS is about $5 to $12/month |
| Their domain's DNS settings (optional) | To put the game at an address like `play.theirsite.com` | Free |
| A Privy account (only for paid play) | Email/Google sign-in and players' built-in wallets | Free to start at https://dashboard.privy.io; check their pricing as player numbers grow |
| A wallet on Robinhood Chain (only for paid play) | Receives the 5% fee, and funds the one-time contract setup | About 0.005 ETH once |

## Step 1. Get their own copy of the code

The code is at `https://github.com/SpamCow/balls`. Pick one:

- **Transfer (simplest if the game is now theirs):** ask the person who made it (ned) to go to the repo's **Settings > General > Transfer ownership** and transfer it to the owner's GitHub account.
- **Fork:** the owner signs in to GitHub, opens the repo, and clicks **Fork**. (If the repo is private, ned must first add them under **Settings > Collaborators**.)

Either way, the owner should end up with `https://github.com/<their-name>/balls`.

## Step 2. Pick the hosting

First ask the owner what hosting they have now, and match it to one of these:

| What they have | Can it run the game? |
|---|---|
| A website builder (Wix, Squarespace, Shopify, Webflow, WordPress.com, GoDaddy Website Builder) | No. Keep the site there, run the game on a VPS (Path A), and link or embed it (Step 3). |
| Plain shared hosting where they upload files by FTP or File Manager, with no "Node.js" option in the control panel | No. Same as above: keep the site, run the game on a VPS (Path A). |
| cPanel hosting that has **Setup Node.js App** in the control panel | Maybe (Path B). It works only if the host lets Node apps use WebSockets, which many shared hosts block. There's a quick test. |
| A VPS or cloud server (DigitalOcean, Hetzner, Vultr, Linode, AWS Lightsail, Hostinger VPS, OVH, etc.) | Yes (Path A). |
| Nothing yet | Get a small VPS (Path A), or use Render (Path C) if they want no server to look after. |

**Path A (VPS) is the recommended route.** The game's address can be a subdomain like `play.theirsite.com` pointing at the VPS, while their main website stays wherever it is.

Every path uses the ready-to-run download, so nothing needs to be built on the server: `https://github.com/<their-name>/balls/releases/download/latest/bumper-balls-server.zip`. GitHub rebuilds it a few minutes after every change to the code. If that link 404s on a fresh fork, open the fork's **Actions** tab, enable workflows if asked, pick **Server zip**, and press **Run workflow**.

### Path A. A VPS (recommended)

1. **Create the server.** At their VPS provider, create the smallest Linux server with at least 1 GB of memory, running **Ubuntu 24.04**. Note its **IP address**. Most providers let them add a password or SSH key and give a "Console" button that opens a terminal in the browser; that is the easiest way for a non-technical owner to type the commands below. Have the owner paste each block, one at a time, and paste back anything that looks like an error.

2. **Point the subdomain at it.** At the domain provider (wherever their domain's DNS is managed), add a record:

   | Type | Name | Value |
   |---|---|---|
   | `A` | `play` (or whatever subdomain they want) | the VPS IP address |

   DNS can take from a few minutes to a few hours. `ping play.theirsite.com` from the server should show the VPS IP once it's ready.

3. **Install Node.js, Caddy and the game.** In the server's terminal:

   ```bash
   sudo apt-get update && sudo apt-get install -y curl unzip ufw debian-keyring debian-archive-keyring apt-transport-https
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt-get update && sudo apt-get install -y caddy
   cd /tmp && curl -fLO https://github.com/<their-name>/balls/releases/download/latest/bumper-balls-server.zip
   sudo rm -rf /opt/bumper-balls && sudo unzip -q bumper-balls-server.zip -d /opt
   ```

4. **Create the settings file.** This makes the server's permanent secret and saves it:

   ```bash
   sudo cp /opt/bumper-balls/example.env /etc/bumper-balls.env
   sudo sed -i "s/^SERVER_SECRET=.*/SERVER_SECRET=$(openssl rand -hex 32)/" /etc/bumper-balls.env
   sudo chmod 600 /etc/bumper-balls.env
   ```

   **Never change or delete `SERVER_SECRET`, and tell the owner to keep a private copy of `/etc/bumper-balls.env` somewhere safe** (for example a password manager; `sudo cat /etc/bumper-balls.env` shows it). The contract address and the key that signs match results come from it. If the server is ever rebuilt, putting the same file back keeps everything working; losing it strands any money in running matches until their timeouts refund it.

5. **Start the game server, and keep it running across reboots:**

   ```bash
   sudo cp /opt/bumper-balls/bumper-balls.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now bumper-balls
   curl -s localhost:8787/healthz
   ```

   The last line should print `{"ok":true}`.

6. **Turn on HTTPS.** Replace `play.theirsite.com` with their real subdomain:

   ```bash
   sudo cp /opt/bumper-balls/Caddyfile /etc/caddy/Caddyfile
   sudo sed -i "s/play.example.com/play.theirsite.com/" /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable
   ```

   Caddy fetches a free HTTPS certificate by itself once DNS from step 2 is working. If DNS wasn't ready yet, wait and run `sudo systemctl restart caddy`.

7. **Check it.** Open `https://play.theirsite.com`. The home page should load, and **Quick game vs bots** should start a match within a few seconds.

To change a setting later (Step 4): `sudo nano /etc/bumper-balls.env`, edit, save (Ctrl+O, Enter, Ctrl+X), then `sudo systemctl restart bumper-balls`. To see the server's log: `sudo journalctl -u bumper-balls -n 50`.

### Path B. cPanel with "Setup Node.js App"

1. On their own computer, download `bumper-balls-server.zip` from the link above.
2. In cPanel **File Manager**, make a folder in their home directory such as `bumper-balls` (not inside `public_html`), upload the zip there, and **Extract** it. Move the contents of the extracted `bumper-balls` folder up so that `app.js`, `dist` and `web` sit directly in `~/bumper-balls`. Also make an empty folder `~/bumper-data`.
3. Open **Setup Node.js App > Create Application**:
   - Node.js version: the highest offered (20 or newer)
   - Application mode: Production
   - Application root: `bumper-balls`
   - Application URL: the domain or subdomain for the game (they can create a subdomain such as `play.theirsite.com` first under **Domains** or **Subdomains**)
   - Application startup file: `app.js`
4. Under **Environment variables**, add:

   | Name | Value |
   |---|---|
   | `SERVER_SECRET` | a long random string, 32+ letters and numbers. Generate one with a password manager. **Keep a private copy and never change it** (same reason as Path A step 4). |
   | `CHAIN_ID` | `46630` |
   | `DATA_DIR` | the full path to `bumper-data`, for example `/home/<cpanel-user>/bumper-data` |
   | `TRUST_PROXY` | `1` |

   Do not set `PORT`; the host handles it. There is no "Run NPM Install" step; the download already contains everything.
5. Press **Create** (or **Restart**), then open the game's address.
6. **The WebSocket test:** press **Quick game vs bots**. If the match starts and the balls move, this hosting works. If the page loads but the match never starts or it says it's reconnecting, the host is blocking WebSockets; ask the host's support "do you support WebSocket connections for Node.js apps?", and if they say no, use Path A instead. Also turn on HTTPS for the domain in cPanel (**SSL/TLS Status > Run AutoSSL**) if it isn't already.

To change a setting later, edit it under **Setup Node.js App** and press **Restart**.

### Path C. Render.com (managed hosting, no server to look after)

Render runs the game straight from their GitHub copy and redeploys on every change. It needs a Render account (Starter plan, about $7/month plus about $0.25/month for the 1 GB disk).

1. Sign in at https://dashboard.render.com (signing in with GitHub is easiest) and allow Render to see the `balls` repo when asked.
2. Click **New > Blueprint**, pick the `balls` repo, and click **Apply**. Render reads `render.yaml` from the repo and creates a web service called `bumper-balls` with a 1 GB disk.
3. Add a payment method if Render asks (the Starter plan is required because the server needs a disk and must stay awake; free instances sleep and drop game rooms).
4. Wait for the first deploy to finish (the build takes a few minutes). The service page shows an address like `https://bumper-balls-xxxx.onrender.com`. Open it; **Play with friends** and **Quick game vs bots** should work right away.
5. For their own subdomain, open the service's **Settings > Custom Domains**, add `play.theirsite.com`, and add the `CNAME` record Render shows at their domain provider. Render issues the HTTPS certificate itself once DNS works.

Render generates `SERVER_SECRET` automatically; never change or delete it. All settings in Step 4 go under the service's **Environment** tab, and saving them redeploys. If a deploy fails, open its **Logs** and have the owner paste the last 30 lines.

### Rules for every path

- Run exactly **one** copy of the server. Game rooms live in its memory.
- The game must be served over **HTTPS** for sign-in and wallets to work.

## Step 3. Put it on their website

Their main website stays where it is. Pick one:

- **Own subdomain (recommended):** that's what Step 2 set up (`play.theirsite.com`). Add a "Play Bumper Balls" link or button on their main site pointing to it.
- **Embed in a page:** paste this into an HTML/embed block on their site (WordPress "Custom HTML" block, Squarespace "Code" block, Wix "Embed HTML", etc.):

  ```html
  <iframe src="https://play.theirsite.com" style="width:100%;height:80vh;border:0" allow="fullscreen; clipboard-write"></iframe>
  ```

  Free play works embedded. Sign-in pop-ups (Google especially) often fail inside an embedded frame, so if they want paid play, use the subdomain link instead.

The game can't be put "inside" a folder of a plain shared-hosting site (like `theirsite.com/game`) by uploading files, because it needs its server running.

## Step 4 (optional). Turn on paid matches

Skip this step if they only want free play. Before turning on real money, tell the owner plainly:

- Real-money games are regulated in many countries and US states. They should check it's legal where they and their players are. The site asks every player to confirm they are 18+ and that paid skill games are legal where they live, but that is not legal cover.
- The smart contract has tests but has **not had a professional security audit**.
- Whoever controls the hosting (and the `SERVER_SECRET`) controls the server that reports winners. Keep the hosting account secure (turn on two-factor sign-in).

Suggest they first try it with **testnet ETH** (free, no value), which is what the server uses by default (`CHAIN_ID` 46630).

### 4a. Set up Privy sign-in (needed for paid play)

Without this, the bet buttons ask for a browser wallet extension instead, which most players won't have.

1. Sign up at https://dashboard.privy.io and create an app (any name, for example "Bumper Balls").
2. In the app's **Login methods** settings, turn on **Email** and **Google**. Leave the others off.
3. In the **Embedded wallets** settings, make sure **Ethereum** wallets are enabled.
4. Under **App settings > Basics > Domains and clients**, in **Allowed origins**, add every address the game is opened from, with `https://` and **no slash at the end**, for example `https://play.theirsite.com` or `https://bumper-balls-xxxx.onrender.com`, pressing **Add** after each. Sign-in is refused on any address not on that list. Privy may suggest a `www.` version too; adding it is fine, but never use it **instead of** the exact address players open (a `*.onrender.com` address never has `www.`). Leave **HttpOnly cookies** off. If sign-in later fails with "Something went wrong" after choosing Google or entering an email, and the browser console (F12 > Console) shows `403` from `auth.privy.io`, this list is the cause.
5. Copy the **App ID** from the app's settings (a short code, not the App Secret; the secret is never needed).
6. Add the setting `PRIVY_APP_ID` with that value and restart the server (VPS: add the line `PRIVY_APP_ID=...` to `/etc/bumper-balls.env` and run `sudo systemctl restart bumper-balls`; cPanel: add it under Environment variables and Restart; Render: add it under Environment).
7. Reload the site. The top-right button now says **Sign in**, and signing in with email or Google shows the player's own wallet panel (balance, deposit address, Cash out, Sign out).

How players use it: sign in, tap their name at the top right, copy their wallet address, and send ETH to it **on Robinhood Chain** (from the Robinhood app, pick Robinhood Chain as the network). If they pick a match with too little in the wallet, the panel opens and says how much more they need. Winnings are claimed back into the same wallet, and **Cash out** sends ETH to any address they paste.

Tell the owner: Privy holds the login and secures the players' built-in wallet keys, so the owner should keep their Privy account secure too (two-factor sign-in).

### 4b. Testnet trial (free)

1. Open the game site and look under **Play for testnet ETH**. It shows a **deployer address** and says it needs a little ETH.
2. Get free Robinhood Chain testnet ETH from a faucet (for example https://www.alchemy.com/faucets/robinhood-testnet) and send about **0.005** to that deployer address.
3. Within about a minute the server deploys its contract and the bet buttons unlock. Two people can now play a 0.001 ETH duel with testnet ETH to see it work end to end (the winner presses **Claim** on the results screen to receive the pot).

### 4c. Real ETH (Robinhood Chain mainnet)

1. Change these settings (VPS: in `/etc/bumper-balls.env`, replacing the `CHAIN_ID=46630` line; cPanel: under Environment variables; Render: under Environment):

   | Key | Value |
   |---|---|
   | `CHAIN_ID` | `4663` |
   | `ALLOW_MAINNET` | `yes` |
   | `FEE_RECIPIENT` | the owner's own wallet address (starts with `0x`). The 5% fee goes here unless `FEE_SPLIT` is set (below). |
   | `FEE_SPLIT` (optional) | splits the 5% between two wallets, for example `0xWalletA:69,0xWalletB:31` (the first wallet gets 69%). |
   | `RPC_URL` (recommended) | a Robinhood Chain mainnet RPC address from a provider such as Alchemy. The free public one is rate-limited. |

   Do not touch `SERVER_SECRET`.
2. Save and restart the server (VPS: `sudo systemctl restart bumper-balls`).
3. Open the site. The section now says **Play for ETH** and shows a deployer address. Send about **0.005 ETH on Robinhood Chain mainnet** (not Ethereum mainnet or another network) to that address. This pays the gas for setting up the contract; leftovers stay in that deployer address.
4. Within about a minute the bet buttons unlock. The page's contract link opens the contract on the Robinhood Chain explorer.

**Splitting the house cut (optional).** With `FEE_SPLIT=0xWalletA:69,0xWalletB:31` set, the server deploys a small splitter contract once (paid from the deployer) and points the house cut at it. When at least 0.002 ETH has piled up it pays both wallets automatically in their shares; the owner can also press **Pay out now** on the **Collect the house cut** page (`/#fees`). Anything collected for `FEE_RECIPIENT` before the split was turned on stays collectable on that same page with the old wallet. To change the split later, edit `FEE_SPLIT` and restart; a new splitter is set up.

**Collecting the house cut.** The 5% from each paid match is held in the contract for the `FEE_RECIPIENT` wallet; it is not sent there by itself. The server settles every finished match on its own (paying a tiny gas fee from the deployer address), so the cut is counted even if the winner never presses Claim. To collect it, the owner opens the game site, clicks **Collect the house cut** at the bottom of the home page (or goes to `https://<their game address>/#fees`), connects the fee wallet with a browser wallet such as MetaMask or Rabby, and presses **Collect**. Keep a little ETH in the deployer address (0.002 is plenty for many matches) so the server can keep settling; the address shows in the server log and was the one funded above.

If the site shows a message instead of unlocking (Step 4c), it says what is missing: `Set ALLOW_MAINNET=yes...`, `Set FEE_RECIPIENT...`, or `Send at least 0.002 ETH to the deployer`. Fix that setting and wait a minute.

Changing `CHAIN_ID` from testnet to mainnet sets up a brand-new contract on mainnet; that's expected. The testnet contract stays on testnet.

## Ball skins

Players pick a skin from **Ball skin** on the home page, and everyone in the match sees it. The skins are the images in `web/public/skins/` in the code. To add one, put a PNG, JPG or WEBP file in that folder and redeploy (push to GitHub, or rebuild on a VPS). The file name becomes the skin's name, so `lava-rock.png` shows as "Lava rock"; use only letters, numbers, `-` and `_`. The picture wraps around the ball like a world map, so a wide image twice as wide as it is tall (for example 1024 × 512) looks best. To remove a skin, delete its file. The four sample skins can be replaced freely.

## Updating the game later

When the code changes on GitHub, wait a few minutes for the **Server zip** build to finish (the repo's **Actions** tab shows it), then:

- **VPS:**

  ```bash
  cd /tmp && curl -fLO https://github.com/<their-name>/balls/releases/download/latest/bumper-balls-server.zip
  sudo rm -rf /opt/bumper-balls && sudo unzip -q bumper-balls-server.zip -d /opt && sudo systemctl restart bumper-balls
  ```

  Settings in `/etc/bumper-balls.env` and data in `/var/lib/bumper-balls` are kept.
- **cPanel:** upload and extract the new zip over the old files in `~/bumper-balls`, then **Restart** the app.
- **Render:** it redeploys by itself.

Avoid updating while a paid match is being played: the server refunds that match when it restarts, which is safe but annoying for the players.

## If something goes wrong

| What the owner sees | What to do |
|---|---|
| Site doesn't load at all (VPS) | Run `sudo systemctl status bumper-balls` and `curl -s localhost:8787/healthz`; if the server isn't running, `sudo journalctl -u bumper-balls -n 50` shows why. A message about `SERVER_SECRET` means the settings file is missing it (Path A step 4) |
| Browser says the connection isn't secure (VPS) | DNS isn't pointing at the VPS yet, or ports 80/443 are closed. Check the `A` record, then `sudo systemctl restart caddy` and `sudo journalctl -u caddy -n 30` |
| Page loads but matches never start | WebSockets are blocked or more than one copy of the server is running. On cPanel, see the WebSocket test in Path B |
| Sign in says the domain isn't allowed, or does nothing | Add the exact site address (with `https://`) to the Privy app's allowed domains (Step 4a) |
| Bet buttons stay locked | Read the message under the paid section and follow it (see Step 4c); confirm the ETH went to the deployer address on the right network |
| A player's money seems stuck | Players connect their wallet, find the match under **Your matches** on the home page, and press **Refund** once the timeout has passed. The refund comes straight from the contract, so it never depends on the server deciding anything |
| Subdomain not working | Check the DNS record at the domain provider points at the right server (VPS: an `A` record with the VPS IP), then wait for DNS |

## Reference: all settings

| Variable | Default | Notes |
|---|---|---|
| `SERVER_SECRET` | none | Required. 32+ random characters. Never change it, and keep a private copy. |
| `CHAIN_ID` | `46630` (testnet) | `4663` is Robinhood Chain mainnet |
| `ALLOW_MAINNET` | not set | Must be `yes` for real ETH |
| `FEE_RECIPIENT` | the deployer address | Required on mainnet; gets the 5% house cut |
| `FEE_SPLIT` | not set | Optional, e.g. `0xA:69,0xB:31`: splits the house cut between two wallets, paid out automatically |
| `RPC_URL` | public RPC | A dedicated provider is more reliable |
| `PRIVY_APP_ID` | not set | Turns on email/Google sign-in with built-in wallets (Step 4a) |
| `WALLETCONNECT_PROJECT_ID` | not set | Only used without Privy, for connecting outside wallets by QR |
| `CONTRACT_ADDRESS` | worked out automatically | Only set if a contract was deployed by hand |
| `DATA_DIR` | `/var/lib/bumper-balls` on a VPS, `/data` on Render | Remembers paid matches in play, usernames and win/loss stats (`profiles.json`) across restarts; back it up |
| `PORT` | `8787` | Leave alone unless the host says otherwise (cPanel sets it itself) |
| `TRUST_PROXY` | `1` on a VPS | Set when Caddy or the host sits in front, so rate limits see players' real addresses |
