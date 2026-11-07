<#
  One-off: move a running BitBob install to BitBull (renamed 7 Nov 2026), keeping everything.

      powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\migrate-from-bitbob.ps1

  What it does:
    1. stops the stack and the link helper, and shuts the old "bitbob" distro down
    2. clones the WHOLE distro into a new "bitbull" one (wsl --export / --import). The old
       distro is not touched and stays installed until you remove it yourself.
    3. inside the copy, renames the folders that carried the old name: ~/BitBob, ~/bitbob-data,
       /srv/bitbob-{links,src,mirrors}, /etc/bitbob-links{,.d}, and the boot command in
       /etc/wsl.conf; removes the old containers
    4. deploys this checkout into it (new image and container names) and starts it
    5. moves the start-at-login shortcut to the new script

  Why a whole-distro clone rather than copying the data folder: ~/bitbob-data is writable by the
  agent, so unpacking an archive of it as root could follow a planted symlink out of the folder
  (threat model P0 #8, the reason the last migration script was deleted). Here WSL copies the
  whole filesystem, and only fixed, script-chosen paths are renamed inside the copy.

  Not touched, and carried over by the new code on first run instead: your vault key
  (%LOCALAPPDATA%\BitBob\vault.key, copied by the link helper), the launcher's settings, and
  the browser's saved settings.

  Options: -Old bitbob  -New bitbull  -InstallDir "%LOCALAPPDATA%\BitBull-WSL"
#>
param(
  [string]$Old = "bitbob",
  [string]$New = "bitbull",
  [string]$InstallDir = "$env:LOCALAPPDATA\BitBull-WSL"
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
foreach ($n in @($Old, $New)) { if ($n -notmatch '^[A-Za-z0-9._-]{1,40}$') { throw "bad distro name: $n" } }
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Wsl([string[]]$a) { & wsl.exe @a; if ($LASTEXITCODE -ne 0) { throw "wsl $($a -join ' ') failed ($LASTEXITCODE)" } }

$distros = (& wsl.exe -l -q) | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($distros -notcontains $Old) { throw "No '$Old' distro to migrate. Installed: $($distros -join ', ')" }
if ($distros -contains $New) { throw "A '$New' distro already exists. Remove it first (wsl --unregister $New) if it is a leftover." }
if (-not (Test-Path "$Repo\.env")) { throw "No .env in $Repo" }

$user = (& wsl.exe -d $Old --exec sh -c 'id -un').Trim()
if ($user -notmatch '^[a-z_][a-z0-9_-]{0,31}$') { throw "unexpected default user in ${Old}: '$user'" }
$home_ = "/home/$user"

Step "1/5 Stopping BitBob and shutting '$Old' down"
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*link-helper.ps1*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
& wsl.exe -d $Old --cd "$home_/BitBob" --exec sh -c "docker compose down 2>/dev/null; true"
Wsl @("--terminate", $Old)

Step "2/5 Cloning '$Old' into '$New' (the old one is left as it is)"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$image = Join-Path $InstallDir "migrate.vhdx"
& wsl.exe --export $Old $image --vhd
if ($LASTEXITCODE -eq 0) {
  Wsl @("--import", $New, "$InstallDir\disk", $image, "--vhd")
} else {
  # older WSL without VHD export: the tar route is slower but equivalent
  $image = Join-Path $InstallDir "migrate.tar"
  Wsl @("--export", $Old, $image)
  Wsl @("--import", $New, "$InstallDir\disk", $image, "--version", "2")
}
Remove-Item -LiteralPath $image -ErrorAction SilentlyContinue

Step "3/5 Renaming inside '$New'"
# Fixed paths only; nothing here is read from the data folder. Written into the distro as a file
# first (a multi-line sh -c argument is mangled by PowerShell's native quoting, see HANDOFF).
$rename = @"
set -e
h=$home_
# the clone's first boot ran the OLD boot command, so linked folders are mounted under the old
# paths right now: unmount them (deepest first) before renaming their parents
for m in `$(awk '`$2 ~ "^/srv/bitbob-" {print `$2}' /proc/mounts | sort -r); do umount "`$m" 2>/dev/null || umount -l "`$m"; done
mvd() { if [ -e "`$1" ] && [ ! -e "`$2" ]; then mv "`$1" "`$2"; echo "  `$1 -> `$2"; fi; }
mvd "`$h/BitBob" "`$h/BitBull"
mvd "`$h/bitbob-data" "`$h/bitbull-data"
for d in links src mirrors; do mvd /srv/bitbob-`$d /srv/bitbull-`$d; done
mvd /etc/bitbob-links /etc/bitbull-links
mvd /etc/bitbob-links.d /etc/bitbull-links.d
rm -f /usr/local/sbin/bitbob-links
sed -i 's#/usr/local/sbin/bitbob-links#/usr/local/sbin/bitbull-links#' /etc/wsl.conf
if grep -q bitbull-links /etc/wsl.conf; then echo "  /etc/wsl.conf boot command updated"; else echo "  NOTE: /etc/wsl.conf had no links boot command to update"; fi
"@ -replace "`r`n", "`n"
$sh = Join-Path $env:TEMP "bitbull-migrate.sh"
[System.IO.File]::WriteAllText($sh, $rename)
$cmd = Join-Path $env:TEMP "bitbull-migrate.cmd"
Set-Content -LiteralPath $cmd -Encoding ASCII -Value "@type `"$sh`" | wsl.exe -d $New -u root --exec sh"
& cmd.exe /c $cmd
if ($LASTEXITCODE -ne 0) { throw "renaming inside $New failed ($LASTEXITCODE); '$Old' is untouched, so nothing is lost: wsl --unregister $New and try again" }

# The old containers came across in the clone under their old names; they would hold port 8787.
Wsl @("-d", $New, "-u", "root", "--exec", "sh", "-c", "service docker start >/dev/null 2>&1 || true; sleep 3; docker rm -f bitbob-agent bitbob-egress bitbob-gateway >/dev/null 2>&1; docker network prune -f >/dev/null 2>&1; true")

Step "4/5 Deploying this checkout into '$New'"
# The links helper script is installed from the deployed tree (provision.sh does the same).
& "$PSScriptRoot\deploy.ps1" -Distro $New
Wsl @("-d", $New, "-u", "root", "--exec", "install", "-m", "755", "$home_/BitBull/scripts/bitbull-wsl/bitbull-links.sh", "/usr/local/sbin/bitbull-links")
Wsl @("--terminate", $New)   # so the new /etc/wsl.conf boot command remounts the linked folders
& "$PSScriptRoot\start.ps1" -Distro $New

Step "5/5 Start at login"
$startup = [Environment]::GetFolderPath("Startup")
$oldLnk = Join-Path $startup "BitBob.lnk"
if (Test-Path -LiteralPath $oldLnk) {
  Remove-Item -LiteralPath $oldLnk
  & "$PSScriptRoot\start.ps1" -Distro $New -InstallAtLogin | Out-Null
  Write-Host "  replaced BitBob.lnk with BitBull.lnk"
} else { Write-Host "  BitBull was not set to start at login; nothing to change" }

Write-Host "`nDone. BitBull: http://localhost:8787" -ForegroundColor Green
Write-Host "Check your chats, linked folders and vault are all there. When you are happy:" -ForegroundColor DarkGray
Write-Host "  wsl --unregister $Old" -ForegroundColor DarkGray
Write-Host "and uninstall the old 'BitBob' app from Settings > Apps (BitBull installs alongside it)." -ForegroundColor DarkGray
