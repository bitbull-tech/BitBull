<#
  One-time: create a dedicated, locked-down WSL distro "bitbob" for BitBob.

  The new distro has no Windows drive mounts, cannot launch Windows programs, and runs
  Docker with user-namespace remapping.

  Run from the repo in PowerShell:
      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\setup.ps1

  By default it downloads Canonical's published Ubuntu 24.04 WSL root filesystem and checks
  it against the SHA256SUMS published beside it. Nothing else is needed on the machine: no
  existing Ubuntu, no Docker on Windows, no Microsoft Store.

  Options:
      -Distro bitbob        name of the distro to create
      -User thetb           Linux user to create inside it
      -InstallDir ...       where its virtual disk lives (default %LOCALAPPDATA%\BitBob-WSL)
      -Sha256 <hex>         require this exact rootfs hash. Recommended: the published
                            SHA256SUMS travels with the file, so it proves the download
                            arrived intact, not that it is the file you reviewed. A hash
                            committed here is reviewed in git. The script prints the hash it
                            used, ready to paste in as the default below.
      -Rootfs <path>        use a tarball you already have, and skip the download
      -RootfsUrl <url>      download from somewhere else (a mirror, a newer release)
      -Source Ubuntu        legacy: build the base image by exporting ubuntu:24.04 from
                            Docker in an existing distro. Needs that distro to have Docker,
                            which is the chicken-and-egg the download replaces.
#>
param(
  [string]$User = $env:USERNAME.ToLower(),
  [string]$Distro = "bitbob",
  [string]$InstallDir = "$env:LOCALAPPDATA\BitBob-WSL",
  [string]$Rootfs = "",
  # The rootfs this was last verified against (5 Nov 2026, ubuntu-noble-wsl-amd64-24.04lts).
  # Pass -Sha256 '' to accept whatever SHA256SUMS currently lists, then pin the new value here.
  [string]$Sha256 = "2a790896740b14d637dbdc583cce1ba081ac53b9e9cdb46dc09a2f73abbd9934",
  [string]$RootfsUrl = "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz",
  [string]$Source = ""
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Wsl([string[]]$a) { & wsl.exe @a; if ($LASTEXITCODE -ne 0) { throw "wsl $($a -join ' ') failed ($LASTEXITCODE)" } }

if ($Distro -notmatch '^[A-Za-z0-9._-]{1,40}$') { throw "bad distro name: $Distro" }
if ($Sha256 -and $Sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "-Sha256 must be 64 hex characters" }

Step "Checking WSL"
& wsl.exe --version *> $null
if ($LASTEXITCODE -ne 0) {
  throw @"
WSL 2 is not installed (or is the old inbox version).
Install it, reboot, then run this script again:

    wsl --install --no-distribution

If that fails, virtualization is probably switched off in your firmware (look for
Intel VT-x / AMD-V, and 'Virtual Machine Platform' in Windows Features).
"@
}

$distros = (& wsl.exe -l -q) | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($distros -contains $Distro) { throw "A distro named '$Distro' already exists. Remove it first with: wsl --unregister $Distro" }
if (-not (Test-Path "$Repo\.env")) { throw "No .env in $Repo" }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ---------------------------------------------------------------- the base image
$downloaded = $false
if ($Rootfs) {
  if (-not (Test-Path -LiteralPath $Rootfs)) { throw "rootfs not found: $Rootfs" }
  $tarWin = (Resolve-Path -LiteralPath $Rootfs).Path
  Step "Using the root filesystem you supplied: $tarWin"
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tarWin).Hash.ToLower()
  Write-Host "  sha256 $hash"
  if ($Sha256 -and $hash -ne $Sha256.ToLower()) { throw "rootfs hash does not match -Sha256" }
}
elseif ($Source) {
  if ($distros -notcontains $Source) { throw "Source distro '$Source' not found. Installed: $($distros -join ', ')." }
  Step "Legacy path: exporting a clean Ubuntu 24.04 image from Docker in $Source"
  $tarWin = Join-Path $InstallDir "rootfs.tar"
  $downloaded = $true   # ours to delete afterwards
  $tarInSource = (& wsl.exe -d $Source --exec wslpath -a ($tarWin -replace '\\', '/')).Trim()
  & wsl.exe -d $Source -u root --exec sh -c "docker compose down 2>/dev/null; true"
  Wsl @("-d", $Source, "-u", "root", "--exec", "sh", "-c", "service docker status >/dev/null 2>&1 || service docker start >/dev/null 2>&1; sleep 2; docker pull -q ubuntu:24.04 && c=`$(docker create ubuntu:24.04) && docker export `$c > '$tarInSource' && docker rm `$c >/dev/null")
}
else {
  $name = Split-Path -Leaf ([uri]$RootfsUrl).AbsolutePath
  if ($name -notmatch '^[A-Za-z0-9._-]+$') { throw "unexpected file name in -RootfsUrl: $name" }
  $tarWin = Join-Path $InstallDir $name
  $sumsWin = Join-Path $InstallDir "SHA256SUMS"
  $sumsUrl = $RootfsUrl -replace '/[^/]+$', '/SHA256SUMS'
  $downloaded = $true

  Step "Downloading Ubuntu 24.04 for WSL (about 300 MB)"
  Write-Host "  $RootfsUrl"
  # Windows PowerShell 5.1 can still default to TLS 1.0, which cloud-images refuses
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
  $prev = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'   # PowerShell 5.1's progress bar makes this crawl
  try {
    Invoke-WebRequest -Uri $RootfsUrl -OutFile $tarWin -UseBasicParsing
    Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsWin -UseBasicParsing
  } finally { $ProgressPreference = $prev }

  Step "Checking the download"
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tarWin).Hash.ToLower()
  $line = Get-Content -LiteralPath $sumsWin | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($name) + '$') } | Select-Object -First 1
  if (-not $line) { throw "$name is not listed in SHA256SUMS at $sumsUrl - refusing to import an unverified image." }
  $want = (($line -split '\s+')[0]).ToLower()
  if ($hash -ne $want) { throw "CHECKSUM MISMATCH for $name`n  got      $hash`n  expected $want`nThe download is corrupt or has been tampered with. Nothing was imported." }
  if ($Sha256 -and $hash -ne $Sha256.ToLower()) { throw "rootfs hash does not match -Sha256`n  got      $hash`n  expected $($Sha256.ToLower())" }
  Remove-Item -LiteralPath $sumsWin -ErrorAction SilentlyContinue
  Write-Host "  sha256 $hash  (matches SHA256SUMS$(if ($Sha256) { ' and -Sha256' }))" -ForegroundColor Green
  if (-not $Sha256) {
    Write-Host "  To pin this image, set it as the -Sha256 default in this script:" -ForegroundColor DarkGray
    Write-Host "      [string]`$Sha256 = `"$hash`"," -ForegroundColor DarkGray
  }
}

Step "Importing distro '$Distro' into $InstallDir"
Wsl @("--import", $Distro, "$InstallDir\disk", $tarWin, "--version", "2")
if ($downloaded) { Remove-Item -LiteralPath $tarWin -ErrorAction SilentlyContinue }

Step "Provisioning (Docker, user, code, data, lockdown) - takes a few minutes"
# Still before the lockdown, so /mnt is available and the repo can be read from Windows.
$repoInGm = (& wsl.exe -d $Distro -u root --exec wslpath -a ($Repo -replace '\\', '/')).Trim()
if (-not $repoInGm -or $repoInGm -notmatch '^/') { throw "could not reach $Repo from $Distro (is /mnt available?)" }
Wsl @("-d", $Distro, "-u", "root", "--exec", "bash", "-c", "tr -d '\r' < '$repoInGm/scripts/bitbob-wsl/provision.sh' > /root/provision.sh && bash /root/provision.sh '$User' '$repoInGm'")

Step "Restarting '$Distro' with the lockdown applied"
Wsl @("--terminate", $Distro)
& "$PSScriptRoot\start.ps1" -Distro $Distro
Start-Sleep -Seconds 5

Step "Checking the walls"
$mnt = (& wsl.exe -d $Distro --exec sh -c "ls /mnt 2>/dev/null | tr '\n' ' '").Trim()
$interop = (& wsl.exe -d $Distro --exec sh -c "cmd.exe /c ver >/dev/null 2>&1 && echo OPEN || echo blocked").Trim()
Write-Host ("  Windows drives visible in $Distro : " + $(if ($mnt) { "YES ($mnt) - check /etc/wsl.conf" } else { "none" }))
Write-Host ("  Launch Windows programs     : " + $interop)

Step "Building and starting BitBob (first build takes several minutes)"
Wsl @("-d", $Distro, "--cd", "~/BitBob", "--exec", "sh", "-c", "COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml BITBOB_DATA_DIR=`$HOME/bitbob-data BITBOB_HOST_DATA_DIR=`$HOME/bitbob-data BITBOB_LINKS_DIR=/srv/bitbob-links docker compose up -d --build && docker compose ps")

Write-Host "`nDone. Open http://localhost:8787" -ForegroundColor Green
Write-Host "Keep editing and committing in $Repo as before; run scripts\bitbob-wsl\deploy.ps1 to ship changes into $Distro."
Write-Host "To start BitBob automatically when you log in: scripts\bitbob-wsl\start.ps1 -InstallAtLogin"
