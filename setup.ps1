# CheaterFlag developer setup (only the admin (cfab) needs this - friends just run the installer).
# Right-click -> Run with PowerShell, or:  powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = 'Stop'
trap { Write-Host "`nERROR: $_" -ForegroundColor Red; Read-Host 'Something went wrong (see above). Press Enter to close'; exit 1 }
Set-Location $PSScriptRoot

function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "== Checking tools ==" -ForegroundColor Cyan
if (-not (Has node)) {
  Write-Host "Installing Node.js LTS..."
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
} else { Write-Host "Node.js $(node -v) found" }
if (-not (Has git)) {
  Write-Host "Installing Git..."
  winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
} else { Write-Host "$(git --version) found" }

# refresh PATH for this session after installs
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

Write-Host "`n== Installing packages ==" -ForegroundColor Cyan
foreach ($d in 'app', 'bot', 'worker') {
  Write-Host "-> $d"
  Push-Location $d; npm install --no-fund --no-audit; Pop-Location
}

Write-Host "`n== Running tests ==" -ForegroundColor Cyan
Push-Location app;    npm test; Pop-Location
Push-Location worker; npm test; Pop-Location

Write-Host "`nSetup complete. Next: .\deploy-worker.ps1" -ForegroundColor Green
Read-Host "Press Enter to close"
