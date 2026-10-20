# Bumper Balls: setup guide for an AI assistant

You are helping the **owner** of this game put it on their own website. The owner may not be technical. Walk them through the steps below one at a time, in plain language, and wait for them to confirm each step before moving on. Ask them to paste what they see (screens, error text, addresses) when something doesn't match this guide.

Do not invent extra steps, and do not ask the owner for any private key or seed phrase. Nothing in this setup needs one.

## What the owner is getting

- A browser game: 3D balls on a shrinking platform, last one on wins. Works on desktop (WASD/arrows, Space to dash) and phones (touch joystick).
- Free modes: **Play with friends** (5-letter room code or invite link, host presses Start, bots can fill empty seats) and **Quick game vs bots**.
- Paid mode (optional): players sign in with email or Google (through **Privy**), which gives each of them a built-in game wallet on **Robinhood Chain**. They send ETH to that wallet, then pay an entry of 0.001, 0.01 or 0.1 ETH into a smart contract. Duels (2 players) or brawls (4 players). Winner takes the pot minus a 5% fee that goes to the owner's wallet. Players can always get their entry back from the contract if a match never fills (10 min) or never finishes (30 min), and can cash their balance out to any address from the wallet panel.
- It is one Node.js server (in a Docker image) that serves the website, runs the game rooms, and sets up the smart contract by itself.

## What the owner needs

| Need | Why | Cost |
|---|---|---|
| A GitHub account | Holds their copy of the code | Free |
| A Render.com account | Runs the game server | Starter plan, about $7/month plus about $0.25/month for the 1 GB disk |
| Their domain's DNS settings (optional) | To put the game at an address like `play.theirsite.com` | Free |
| A Privy account (only for paid play) | Email/Google sign-in and players' built-in wallets | Free to start at https://dashboard.privy.io; check their pricing as player numbers grow |
| A wallet on Robinhood Chain (only for paid play) | Receives the 5% fee, and funds the one-time contract setup | About 0.005 ETH once |

## Step 1. Get their own copy of the code

The code is at `https://github.com/SpamCow/balls`. Pick one:

- **Transfer (simplest if the game is now theirs):** ask the person who made it (ned) to go to the repo's **Settings > General > Transfer ownership** and transfer it to the owner's GitHub account.
- **Fork:** the owner signs in to GitHub, opens the repo, and clicks **Fork**. (If the repo is private, ned must first add them under **Settings > Collaborators**.)

Either way, the owner should end up with `https://github.com/<their-name>/balls`.

## Step 2. Create the server on Render

1. Sign in at https://dashboard.render.com (signing in with GitHub is easiest) and allow Render to see the `balls` repo when asked.
2. Click **New > Blueprint**, pick the `balls` repo, and click **Apply**. Render reads `render.yaml` from the repo and creates a web service called `bumper-balls` with a 1 GB disk.
3. Add a payment method if Render asks (the Starter plan is required because the server needs a disk and must stay awake).
4. Wait for the first deploy to finish (the build takes a few minutes). The service page shows an address like `https://bumper-balls-xxxx.onrender.com`.
5. Open that address. The game's home page should load, and **Play with friends** and **Quick game vs bots** should work right away.

Render generates `SERVER_SECRET` automatically. **Never change or delete it**: the contract address and the key that signs match results come from it, and changing it would strand any money in running matches.

Keep the service at exactly **1 instance**. Game rooms live in the server's memory.

## Step 3. Put it on their website

Pick one:

- **Own subdomain (recommended):** in Render, open the service, go to **Settings > Custom Domains**, add something like `play.theirsite.com`, then add the CNAME record Render shows at their domain provider (GoDaddy, Namecheap, Cloudflare, Squarespace, etc.). Render issues the HTTPS certificate on its own once DNS works, which can take from minutes to a few hours.
- **Link or button:** on their existing site, add a link or button to the Render (or custom domain) address.
- **Embed in a page:** paste this into an HTML/embed block on their site, using their game address:

  ```html
  <iframe src="https://play.theirsite.com" style="width:100%;height:80vh;border:0" allow="fullscreen; clipboard-write"></iframe>
  ```

  Free play works embedded. Sign-in pop-ups (Google especially) often fail inside an embedded frame, so if they want paid play, use a subdomain or link instead.

## Step 4 (optional). Turn on paid matches

Skip this step if they only want free play. Before turning on real money, tell the owner plainly:

- Real-money games are regulated in many countries and US states. They should check it's legal where they and their players are. The site asks every player to confirm they are 18+ and that paid skill games are legal where they live, but that is not legal cover.
- The smart contract has tests but has **not had a professional security audit**.
- Whoever controls the Render account controls the server that reports winners. Keep that account secure (turn on two-factor sign-in).

Suggest they first try it with **testnet ETH** (free, no value), which is what the server uses by default (`CHAIN_ID` 46630).

### 4a. Set up Privy sign-in (needed for paid play)

Without this, the bet buttons ask for a browser wallet extension instead, which most players won't have.

1. Sign up at https://dashboard.privy.io and create an app (any name, for example "Bumper Balls").
2. In the app's **Login methods** settings, turn on **Email** and **Google**. Leave the others off.
3. In the **Embedded wallets** settings, make sure **Ethereum** wallets are enabled.
4. In the app's allowed domains settings (Privy calls this the allowed origins / domains list), add every address the game is opened from: the `https://bumper-balls-xxxx.onrender.com` address and the custom domain from Step 3, if any. Sign-in is refused on any address not on that list.
5. Copy the **App ID** from the app's settings (a short code, not the App Secret; the secret is never needed).
6. In Render, open the service, go to **Environment**, add `PRIVY_APP_ID` with that value, and save. Render redeploys.
7. Reload the site. The top-right button now says **Sign in**, and signing in with email or Google shows the player's own wallet panel (balance, deposit address, Cash out, Sign out).

How players use it: sign in, tap their name at the top right, copy their wallet address, and send ETH to it **on Robinhood Chain** (from the Robinhood app, pick Robinhood Chain as the network). If they pick a match with too little in the wallet, the panel opens and says how much more they need. Winnings are claimed back into the same wallet, and **Cash out** sends ETH to any address they paste.

Tell the owner: Privy holds the login and secures the players' built-in wallet keys, so the owner should keep their Privy account secure too (two-factor sign-in).

### 4b. Testnet trial (free)

1. Open the game site and look under **Play for testnet ETH**. It shows a **deployer address** and says it needs a little ETH.
2. Get free Robinhood Chain testnet ETH from a faucet (for example https://www.alchemy.com/faucets/robinhood-testnet) and send about **0.005** to that deployer address.
3. Within about a minute the server deploys its contract and the bet buttons unlock. Two people can now play a 0.001 ETH duel with testnet ETH to see it work end to end (the winner presses **Claim** on the results screen to receive the pot).

### 4c. Real ETH (Robinhood Chain mainnet)

1. In Render, open the service, go to **Environment**, and set:

   | Key | Value |
   |---|---|
   | `CHAIN_ID` | `4663` |
   | `ALLOW_MAINNET` | `yes` |
   | `FEE_RECIPIENT` | the owner's own wallet address (starts with `0x`). The 5% fee goes here, and it can't be changed after the contract is set up, so double-check it. |
   | `RPC_URL` (recommended) | a Robinhood Chain mainnet RPC address from a provider such as Alchemy. The free public one is rate-limited. |

   Do not touch `SERVER_SECRET`.
2. Save. Render redeploys (if not, press **Manual Deploy > Deploy latest commit**).
3. Open the site. The section now says **Play for ETH** and shows a deployer address. Send about **0.005 ETH on Robinhood Chain mainnet** (not Ethereum mainnet or another network) to that address. This pays the gas for setting up the contract; leftovers stay in that deployer address.
4. Within about a minute the bet buttons unlock. The page's contract link opens the contract on the Robinhood Chain explorer.

If the site shows a message instead of unlocking (Step 4c), it says what is missing: `Set ALLOW_MAINNET=yes...`, `Set FEE_RECIPIENT...`, or `Send at least 0.002 ETH to the deployer`. Fix that setting and wait a minute.

Changing `CHAIN_ID` from testnet to mainnet sets up a brand-new contract on mainnet; that's expected. The testnet contract stays on testnet.

## Updating the game later

Render redeploys automatically when new code lands on the repo's `main` branch (if auto-deploy is off, press **Manual Deploy**). Avoid redeploying while a paid match is being played: the server refunds that match when it restarts, which is safe but annoying for the players.

## If something goes wrong

| What the owner sees | What to do |
|---|---|
| Deploy fails on Render | Open the deploy's **Logs** and have the owner paste the last 30 lines |
| Site loads but games never start | Check the service is on 1 instance and the Starter plan (free instances sleep and drop rooms) |
| Sign in says the domain isn't allowed, or does nothing | Add the exact site address (with `https://`) to the Privy app's allowed domains (Step 4a) |
| Bet buttons stay locked | Read the message under the paid section and follow it (see Step 4b); confirm the ETH went to the deployer address on the right network |
| A player's money seems stuck | Players connect their wallet, find the match under **Your matches** on the home page, and press **Refund** once the timeout has passed. The refund comes straight from the contract, so it never depends on the server deciding anything |
| Custom domain not working | Check the CNAME at the domain provider matches what Render shows exactly, then wait for DNS |

## Reference: all settings

| Variable | Default | Notes |
|---|---|---|
| `SERVER_SECRET` | generated by Render | Required. Never change it. |
| `CHAIN_ID` | `46630` (testnet) | `4663` is Robinhood Chain mainnet |
| `ALLOW_MAINNET` | not set | Must be `yes` for real ETH |
| `FEE_RECIPIENT` | the deployer address | Required on mainnet; fixed once the contract is set up |
| `RPC_URL` | public RPC | A dedicated provider is more reliable |
| `PRIVY_APP_ID` | not set | Turns on email/Google sign-in with built-in wallets (Step 4a) |
| `WALLETCONNECT_PROJECT_ID` | not set | Only used without Privy, for connecting outside wallets by QR |
| `CONTRACT_ADDRESS` | worked out automatically | Only set if a contract was deployed by hand |
| `DATA_DIR` | `/data` (the Render disk) | Remembers paid matches in play across restarts |
