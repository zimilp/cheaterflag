# One-time: lets the Stats tab include members' FACEIT CS2 matches.
# Needs a free FACEIT "server-side" API key. It is stored in secrets.env and in Cloudflare, never printed.
$ErrorActionPreference = 'Continue'
trap { Write-Host "`nERROR: $_" -ForegroundColor Red; Read-Host 'Something went wrong (see above). Press Enter to close'; exit 1 }
Set-Location $PSScriptRoot
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Set-EnvValue($path, $key, $value) {
  $lines = @([IO.File]::ReadAllLines((Resolve-Path $path), [Text.Encoding]::UTF8))   # UTF-8 in and out (PS 5.1 Get-Content reads ANSI and garbles)
  if ($lines -match "^$key=") { $lines = $lines -replace "^$key=.*", "$key=$value" } else { $lines += "$key=$value" }
  [IO.File]::WriteAllText((Resolve-Path $path), (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
}

Write-Host ""
Write-Host "The FACEIT developer page opens. On that page:" -ForegroundColor Cyan
Write-Host "  1. Sign in with your FACEIT account."
Write-Host "  2. Click 'App Studio' > 'Create app' (any name, e.g. CheaterFlag)."
Write-Host "  3. In the app, open 'API keys' > 'Create' > type 'Server side' > name it CheaterFlag."
Write-Host "  4. Copy the key."
Write-Host ""
Start-Process 'https://developers.faceit.com/'
$sec = Read-Host 'Paste the key here (it stays hidden) and press Enter' -AsSecureString
$key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if (-not $key) { throw 'No key pasted.' }

Write-Host "Checking the key..." -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri 'https://open.faceit.com/data/v4/games/cs2' -Headers @{ Authorization = "Bearer $key" } -UseBasicParsing | Out-Null
} catch {
  throw "FACEIT did not accept the key. Make sure it is a 'Server side' key, then run this again."
}

Set-EnvValue 'secrets.env' 'FACEIT_API_KEY' $key
Push-Location worker
$key | npx wrangler secret put FACEIT_API_KEY 2>&1 | Out-Null
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw 'Could not store the key in Cloudflare. Run "npm run deploy" once, then this again.' }

Write-Host "`nDone. Members' FACEIT matches will appear in the Stats tab within an hour or so." -ForegroundColor Green
Read-Host "Press Enter to close"
