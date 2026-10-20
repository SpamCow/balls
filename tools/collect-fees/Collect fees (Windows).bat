@echo off
rem Double-click to pay the house cut out to both FEE_SPLIT wallets.
rem No keys needed: the game server sends the payout and pays the gas.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$site = (Get-Content site.txt -TotalCount 1).Trim().TrimEnd('/');" ^
  "Write-Host ('Asking ' + $site + ' to pay out the house cut...');" ^
  "try { $r = Invoke-RestMethod -Method Post -Uri ($site + '/api/fees/payout');" ^
  "  if ($r.hash) { Write-Host 'Paid out to both wallets.'; Write-Host ('Transaction: https://robin.etherscan.io/tx/' + $r.hash) } else { Write-Host 'Nothing to pay out right now.' } }" ^
  "catch { Write-Host 'Did not work. The server said:'; if ($_.ErrorDetails) { Write-Host $_.ErrorDetails.Message } else { Write-Host $_.Exception.Message } }"
echo.
pause
