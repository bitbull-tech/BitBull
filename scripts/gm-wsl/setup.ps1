<#
  One-time: create a dedicated, locked-down WSL distro "gm" for the GM Agent.

  The new distro has no Windows drive mounts, cannot launch Windows programs, and runs
  Docker with user-namespace remapping. Your everyday Ubuntu (with D: and C: mounted)
  is only used to build the base image and is left as it is.

  Run from the repo in PowerShell:
      powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\setup.ps1
  Options:
      -Source Ubuntu      the existing distro that has Docker (used once, to export a clean Ubuntu image)
      -User thetb         Linux user to create inside gm
      -InstallDir ...     where the gm virtual disk lives (default %LOCALAPPDATA%\GM-WSL)
#>
param(
  [string]$Source = "Ubuntu",
  [string]$User = $env:USERNAME.ToLower(),
  [string]$Distro = "gm",
  [string]$InstallDir = "$env:LOCALAPPDATA\GM-WSL"
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Wsl([string[]]$a) { & wsl.exe @a; if ($LASTEXITCODE -ne 0) { throw "wsl $($a -join ' ') failed ($LASTEXITCODE)" } }

$distros = (& wsl.exe -l -q) | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($distros -contains $Distro) { throw "A distro named '$Distro' already exists. Remove it first with: wsl --unregister $Distro" }
if ($distros -notcontains $Source) { throw "Source distro '$Source' not found. Installed: $($distros -join ', '). Pass -Source <name>." }
if (-not (Test-Path "$Repo\.env")) { throw "No .env in $Repo" }

$repoInSource = (& wsl.exe -d $Source --exec wslpath -a ($Repo -replace '\\', '/')).Trim()

Step "Stopping any GM containers in $Source"
& wsl.exe -d $Source -u root --cd $repoInSource --exec sh -c "docker compose down 2>/dev/null; true"

Step "Exporting a clean Ubuntu 24.04 image from Docker in $Source"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$tarWin = Join-Path $InstallDir "rootfs.tar"
$tarInSource = (& wsl.exe -d $Source --exec wslpath -a ($tarWin -replace '\\', '/')).Trim()
Wsl @("-d", $Source, "-u", "root", "--exec", "sh", "-c", "service docker status >/dev/null 2>&1 || service docker start >/dev/null 2>&1; sleep 2; docker pull -q ubuntu:24.04 && c=`$(docker create ubuntu:24.04) && docker export `$c > '$tarInSource' && docker rm `$c >/dev/null")

Step "Importing distro '$Distro' into $InstallDir"
Wsl @("--import", $Distro, "$InstallDir\disk", $tarWin, "--version", "2")
Remove-Item $tarWin

Step "Provisioning (Docker, user, code, data, lockdown) - takes a few minutes"
$repoInGm = (& wsl.exe -d $Distro -u root --exec wslpath -a ($Repo -replace '\\', '/')).Trim()
Wsl @("-d", $Distro, "-u", "root", "--exec", "bash", "-c", "tr -d '\r' < '$repoInGm/scripts/gm-wsl/provision.sh' > /root/provision.sh && bash /root/provision.sh '$User' '$repoInGm'")

Step "Restarting '$Distro' with the lockdown applied"
Wsl @("--terminate", $Distro)
& "$PSScriptRoot\start.ps1" -Distro $Distro
Start-Sleep -Seconds 5

Step "Checking the walls"
$mnt = (& wsl.exe -d $Distro --exec sh -c "ls /mnt 2>/dev/null | tr '\n' ' '").Trim()
$interop = (& wsl.exe -d $Distro --exec sh -c "cmd.exe /c ver >/dev/null 2>&1 && echo OPEN || echo blocked").Trim()
Write-Host ("  Windows drives visible in gm : " + $(if ($mnt) { "YES ($mnt) - check /etc/wsl.conf" } else { "none" }))
Write-Host ("  Launch Windows programs     : " + $interop)

Step "Building and starting GM (first build takes several minutes)"
Wsl @("-d", $Distro, "--cd", "~/SayGMAgent", "--exec", "sh", "-c", "GM_DATA_DIR=`$HOME/gm-data GM_HOST_DATA_DIR=`$HOME/gm-data GM_LINKS_DIR=/srv/gm-links docker compose up -d --build && docker compose ps")

Write-Host "`nDone. Open http://localhost:8787" -ForegroundColor Green
Write-Host "Keep editing and committing in $Repo as before; run scripts\gm-wsl\deploy.ps1 to ship changes into gm."
Write-Host "To start GM automatically when you log in: scripts\gm-wsl\start.ps1 -InstallAtLogin"
