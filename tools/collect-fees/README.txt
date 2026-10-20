Collect the house cut with a double-click

1. Put the game's web address on the first line of site.txt (it's set to ned's test site).
2. Mac: double-click "Collect fees (Mac).command". The first time, macOS may block it:
   right-click it, choose Open, then Open again.
   Windows: double-click "Collect fees (Windows).bat".

It asks the game server to pay the house cut out to the two FEE_SPLIT wallets right away.
No private keys are stored or needed: the split contract can only ever pay those two wallets,
and the server pays the gas. FEE_SPLIT must be set on the server for this to work.
The server also pays out by itself whenever 0.002 ETH has built up, so this is only for
collecting sooner. It can run once a minute.
