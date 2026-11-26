# One-time: lets the CheaterFlag service start the demo bot the moment a demo link is needed.
# (GitHub's 5-minute schedule is "best effort" and can be hours late.)
# The token only allows starting GitHub Actions runs in the cheaterflag repo. It is stored in
# secrets.env and in Cloudflare, and is never printed.
$ErrorActionPreference = 'Continue'
trap { Write-Host "`nERROR: $_" -ForegroundColor Red; Read-Host 'Something went wrong (see above). Press Enter to close'; exit 1 }
Set-Location $PSScriptRoot
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Set-EnvValue($path, $key, $value) {
  $lines = @([IO.File]::ReadAllLines((Resolve-Path $path), [Text.Encoding]::UTF8))   # UTF-8 in and out (PS 5.1 Get-Content reads ANSI and garbles)
  if ($lines -match "^$key=") { $lines = $lines -replace "^$key=.*", "$key=$value" } else { $lines += "$key=$value" }
  [IO.File]::WriteAllText((Resolve-Path $path), (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
}

$url = 'https://github.com/settings/personal-access-tokens/new?name=CheaterFlag+bot+wake-up&description=Lets+the+CheaterFlag+service+start+the+demo+bot&target_name=zimilp&expires_in=365&actions=write'
Write-Host ""
Write-Host "A GitHub page opens with the token already filled in. On that page:" -ForegroundColor Cyan
Write-Host "  1. Repository access: choose 'Only select repositories' and pick 'cheaterflag'."
Write-Host "  2. Check that Permissions shows 'Actions: Read and write' (it is pre-selected)."
Write-Host "  3. Click 'Generate token' at the bottom, then click the copy icon next to the token."
Write-Host ""
Start-Process $url
$sec = Read-Host 'Paste the token here (it stays hidden) and press Enter' -AsSecureString
$tok = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if (-not $tok) { throw 'No token pasted.' }

Write-Host "Checking the token (this starts one bot run)..." -ForegroundColor Cyan
try {
  Invoke-RestMethod -Method Post -Uri 'https://api.github.com/repos/zimilp/cheaterflag/actions/workflows/bot.yml/dispatches' `
    -Headers @{ Authorization = "Bearer $tok"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'cheaterflag' } `
    -ContentType 'application/json' -Body '{"ref":"main"}' -UseBasicParsing | Out-Null
} catch {
  throw "GitHub did not accept the token. Make sure the cheaterflag repo is selected and Actions is 'Read and write', then run this again."
}

Set-EnvValue 'secrets.env' 'GITHUB_DISPATCH_TOKEN' $tok
Push-Location worker
$tok | npx wrangler secret put GITHUB_DISPATCH_TOKEN 2>&1 | Out-Null
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw 'Could not store the token in Cloudflare. Run "npm run deploy" once, then this again.' }

Write-Host "`nDone. The demo bot now starts within about a minute whenever a demo link is needed." -ForegroundColor Green
Read-Host "Press Enter to close"
