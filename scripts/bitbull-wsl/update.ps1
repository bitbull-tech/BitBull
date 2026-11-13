<#
  Update BitBull: get the latest code from GitHub, then rebuild from it (deploy.ps1).
  Your chats, files and .env are not touched.
      powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\update.ps1
#>
param([string]$Distro = "bitbull")
$ErrorActionPreference = "Stop"
if ($Distro -notmatch '^[A-Za-z0-9._-]{1,40}$') { throw "bad distro name" }
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git isn't installed. Install it with: winget install --id Git.Git -e" }
if (-not (Test-Path -LiteralPath (Join-Path $Repo ".git"))) { throw "$Repo isn't a git download of BitBull, so it can't be updated this way." }

Write-Host "==> Getting the latest BitBull from GitHub" -ForegroundColor Cyan
# fast-forward only: local changes or commits are never overwritten or merged behind your back
& git -C $Repo pull --ff-only
if ($LASTEXITCODE -ne 0) { throw "Couldn't update the code in $Repo. If you changed files there, see: git -C `"$Repo`" status" }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "deploy.ps1") -Distro $Distro
exit $LASTEXITCODE
