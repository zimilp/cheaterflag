# Pushes CheaterFlag to github.com/zimilp/cheaterflag and builds the installer.
# Run AFTER deploy-worker.ps1 (so the service URL is baked into the installer).
# Usage: powershell -ExecutionPolicy Bypass -File .\publish.ps1 [-Version 0.1.0]
param([string]$Version = '')
$ErrorActionPreference = 'Continue'  # git prints progress to stderr; we check exit codes instead
trap { Write-Host "`nERROR: $_" -ForegroundColor Red; Read-Host 'Something went wrong (see above). Press Enter to close'; exit 1 }
Set-Location $PSScriptRoot

# GitHub only runs workflows from .github/workflows
New-Item -ItemType Directory -Force -Path '.github\workflows' | Out-Null
Copy-Item 'ci\release.yml' '.github\workflows\release.yml' -Force

if (-not (Test-Path '.git')) {
  git init -b main | Out-Null
  git remote add origin https://github.com/zimilp/cheaterflag.git
}

# Safety: never publish secrets
foreach ($f in 'secrets.env', 'Steam Account.txt') {
  if (git ls-files $f) { throw "$f is tracked by git - stopping." }
}

$pkg = Get-Content 'app\package.json' -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $pkg.version }
git add -A
git commit -m "CheaterFlag v$Version" 2>$null | Out-Null
git push -u origin main          # first time: a browser window asks you to sign in to GitHub
if ($LASTEXITCODE -ne 0) { throw 'Push to GitHub failed - see the message above.' }
git tag "v$Version" 2>$null
git push origin "v$Version"
if ($LASTEXITCODE -ne 0) { throw 'Pushing the version tag failed - see the message above.' }

Write-Host "`nPushed v$Version. GitHub is now building the installer (about 5-10 minutes):" -ForegroundColor Green
Write-Host "  https://github.com/zimilp/cheaterflag/actions"
Write-Host "When it finishes, the download link for friends is:"
Write-Host "  https://github.com/zimilp/cheaterflag/releases/latest"
Read-Host "Press Enter to close"
