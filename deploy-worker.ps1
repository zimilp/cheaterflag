# Deploys the free CheaterFlag shared service to Cloudflare (Workers + D1).
# Reads secrets.env; secret values are piped straight to Cloudflare and never printed.
$ErrorActionPreference = 'Continue'  # wrangler prints warnings to stderr; we check exit codes instead
trap { Write-Host "`nERROR: $_" -ForegroundColor Red; Read-Host 'Something went wrong (see above). Press Enter to close'; exit 1 }
Set-Location $PSScriptRoot

function Read-Env($path) {
  $h = @{}
  foreach ($l in [IO.File]::ReadAllLines((Resolve-Path $path), [Text.Encoding]::UTF8)) { if ($l -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $h[$matches[1]] = $matches[2].Trim('"', "'") } }
  return $h
}
function Set-EnvValue($path, $key, $value) {
  $lines = @([IO.File]::ReadAllLines((Resolve-Path $path), [Text.Encoding]::UTF8))   # UTF-8 in and out (PS 5.1 Get-Content reads ANSI and garbles)
  if ($lines -match "^$key=") { $lines = $lines -replace "^$key=.*", "$key=$value" } else { $lines += "$key=$value" }
  [IO.File]::WriteAllText((Resolve-Path $path), (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
}

$secrets = Read-Env 'secrets.env'
foreach ($k in 'STEAM_API_KEY', 'SESSION_SECRET', 'BOT_SECRET') { if (-not $secrets[$k]) { throw "Missing $k in secrets.env" } }

Push-Location worker
Write-Host "== Signing in to Cloudflare (a browser window opens) ==" -ForegroundColor Cyan
$who = npx wrangler whoami 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $who -match 'not authenticated|wrangler login') {
  npx wrangler login
  if ($LASTEXITCODE -ne 0) { throw 'Cloudflare sign-in did not complete.' }
}

$toml = [IO.File]::ReadAllText((Resolve-Path 'wrangler.toml'), [Text.Encoding]::UTF8)
if ($toml -match 'REPLACE_WITH_D1_ID') {
  Write-Host "== Creating database ==" -ForegroundColor Cyan
  $out = npx wrangler d1 create cheaterflag 2>&1 | Out-String
  if ($out -notmatch '"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"') { Write-Host $out; throw "Could not read the new database id" }
  $toml = $toml -replace 'REPLACE_WITH_D1_ID', $matches[1]
  [IO.File]::WriteAllText((Resolve-Path 'wrangler.toml'), $toml)
}

Write-Host "== Creating tables ==" -ForegroundColor Cyan
npx wrangler d1 execute cheaterflag --remote --file schema.sql -y
if ($LASTEXITCODE -ne 0) { throw 'Creating tables failed - see the message above.' }
# upgrades for databases created by older versions (an error here just means it's already done)
npx wrangler d1 execute cheaterflag --remote --command "ALTER TABLE flags ADD COLUMN extra TEXT" -y 2>&1 | Out-Null

Write-Host "== Deploying ==" -ForegroundColor Cyan
$dep = npx wrangler deploy 2>&1 | Out-String
Write-Host $dep
if ($LASTEXITCODE -ne 0) { throw 'Deploy failed - see the message above.' }
Write-Host "== Storing secrets (values are not shown) ==" -ForegroundColor Cyan
$secretKeys = @('STEAM_API_KEY', 'SESSION_SECRET', 'BOT_SECRET')
if ($secrets['GITHUB_DISPATCH_TOKEN']) { $secretKeys += 'GITHUB_DISPATCH_TOKEN' }   # lets the service wake the bot instantly
if ($secrets['FACEIT_API_KEY']) { $secretKeys += 'FACEIT_API_KEY' }                 # members' FACEIT matches in the Stats tab
foreach ($k in $secretKeys) {
  $secrets[$k] | npx wrangler secret put $k 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not store $k" }
  Write-Host "  $k set"
}

Pop-Location
if ($dep -match '(https://cheaterflag\.[a-z0-9-]+\.workers\.dev)') {
  $url = $matches[1]
  Set-EnvValue 'secrets.env' 'WORKER_URL' $url
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'app\config.json'), "{`n  `"workerUrl`": `"$url`"`n}`n")
  Write-Host "`nService is live at $url (saved to secrets.env and app/config.json)" -ForegroundColor Green
} else { Write-Host "Deployed, but couldn't read the URL - copy it from above into secrets.env as WORKER_URL." -ForegroundColor Yellow }
Read-Host "Press Enter to close"
