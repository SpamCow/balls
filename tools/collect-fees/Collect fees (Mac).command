#!/bin/bash
# Double-click to pay the house cut out to both FEE_SPLIT wallets.
# No keys needed: the game server sends the payout and pays the gas.
cd "$(dirname "$0")"
SITE=$(head -n1 site.txt | tr -d '\r' | sed 's#/*$##')
echo "Asking $SITE to pay out the house cut..."
RES=$(curl -s -X POST "$SITE/api/fees/payout")
HASH=$(printf '%s' "$RES" | sed -n 's/.*"hash":"\(0x[0-9a-fA-F]*\)".*/\1/p')
if [ -n "$HASH" ]; then
  echo "Paid out to both wallets."
  echo "Transaction: https://robin.etherscan.io/tx/$HASH"
elif printf '%s' "$RES" | grep -q '"hash":null'; then
  echo "Nothing to pay out right now."
else
  echo "Didn't work. The server said:"
  echo "$RES"
fi
echo
read -n 1 -s -r -p "Press any key to close"
