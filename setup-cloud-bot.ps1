# Moves the CheaterFlag bot to GitHub (free), so it no longer depends on your PC.
# Copies the bot's saved login token and shared secret into your repo's encrypted GitHub secrets.
# Values are piped straight to GitHub and never printed.
# Usage: npm run cloud-bot   (run publish-app first, so the bot workflow is on GitHub)
$ErrorActionPreference = 'Continue'
trap { Write-Host "`nERROR: $_" -ForegroundColor Red; Read-Host 'Something went wrong (see above). Press Enter to close'; exit 1 }
Set-Location $PSScriptRoot
$repo = 'zimilp/cheaterflag'

function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
if (-not (Has gh)) {
  Write-Host "Installing GitHub CLI..." -ForegroundColor Cyan
  winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "== Sign in to GitHub (a browser window opens; copy the one-time code it shows) ==" -ForegroundColor Cyan
  gh auth login --hostname github.com --git-protocol https --web
  if ($LASTEXITCODE -ne 0) { throw 'GitHub sign-in did not complete.' }
}

$tokenFile = 'bot\data\refresh-token.txt'
if (-not (Test-Path $tokenFile)) { throw "No saved bot login found. Run 'npm run bot' once and sign the bot in first." }
$botSecret = ([IO.File]::ReadAllLines((Resolve-Path 'secrets.env'), [Text.Encoding]::UTF8) | Where-Object { $_ -match '^BOT_SECRET=' }) -replace '^BOT_SECRET=', ''
if (-not $botSecret) { throw 'BOT_SECRET missing from secrets.env' }

Write-Host "== Storing secrets on GitHub (values are not shown) ==" -ForegroundColor Cyan
Get-Content $tokenFile -Raw | gh secret set BOT_REFRESH_TOKEN --repo $repo
if ($LASTEXITCODE -ne 0) { throw 'Could not store BOT_REFRESH_TOKEN' }
$botSecret | gh secret set BOT_SECRET --repo $repo
if ($LASTEXITCODE -ne 0) { throw 'Could not store BOT_SECRET' }
Write-Host "  BOT_REFRESH_TOKEN set`n  BOT_SECRET set"

Write-Host "== Starting the cloud bot ==" -ForegroundColor Cyan
gh workflow enable bot.yml --repo $repo 2>&1 | Out-Null
gh workflow run bot.yml --repo $repo
if ($LASTEXITCODE -ne 0) { throw 'Could not start the bot workflow. Did you run "npm run publish-app" first?' }

Write-Host "`nDone. The bot now runs on GitHub every 5 minutes." -ForegroundColor Green
Write-Host "IMPORTANT: stop the bot on your PC (Ctrl + C in its window) - Steam only allows one sign-in at a time."
Write-Host "Check it here: https://github.com/$repo/actions/workflows/bot.yml"
Read-Host "Press Enter to close"
