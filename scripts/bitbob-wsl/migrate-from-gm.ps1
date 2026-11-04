<#
  One-off: move from the old "gm" distro (GM Agent) to a fresh "bitbob" distro (BitBob),
  keeping chats, projects, uploads and settings. Run from the renamed repo in PowerShell:

      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\migrate-from-gm.ps1

  What it does, in order:
    1. backs up ~/gm-data from the old distro to Documents\BitBob backups\gm-data-<date>.tgz
    2. stops the old stack and the old distro (nothing is deleted)
    3. runs setup.ps1 (new locked-down "bitbob" distro, Docker, code, first build)
    4. puts the backed-up data in place as ~/bitbob-data and starts BitBob
    5. lists the folders that were linked read-only in the old distro, so you can link them again
  The old distro stays until you remove it yourself:  wsl --unregister gm
  Options: -Old gm  -New bitbob  -Source Ubuntu (the distro setup.ps1 exports a clean image from)
           -RestoreFrom "<backup>.tgz"   skip steps 1-3 (the new distro exists) and restore that file
#>
param(
  [string]$Old = "gm",
  [string]$New = "bitbob",
  [string]$Source = "Ubuntu",
  [string]$BackupDir = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "BitBob backups"),
  [string]$RestoreFrom = ""   # resume at step 4 with a backup made earlier (the .tgz path)
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
foreach ($n in @($Old, $New, $Source)) { if ($n -notmatch '^[A-Za-z0-9._-]{1,40}$') { throw "bad distro name: $n" } }
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Wsl([string[]]$a) { & wsl.exe @a; if ($LASTEXITCODE -ne 0) { throw "wsl $($a -join ' ') failed ($LASTEXITCODE)" } }

$file = $RestoreFrom
if ($RestoreFrom) {
  if (-not (Test-Path -LiteralPath $RestoreFrom)) { throw "backup not found: $RestoreFrom" }
  $oldLinks = ""
  Write-Host "Resuming at step 4 with $RestoreFrom" -ForegroundColor Cyan
} else {
  $distros = (& wsl.exe -l -q) | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  if ($distros -notcontains $Old) { throw "No '$Old' distro to migrate from. Installed: $($distros -join ', '). For a plain fresh install run setup.ps1." }
  if ($distros -contains $New) { throw "A '$New' distro already exists. Remove it first (wsl --unregister $New) or migrate by hand." }
  if (-not (Test-Path "$Repo\.env")) { throw "No .env in $Repo (copy it from the old checkout)." }

  Step "1/5 Backing up the old data (${Old}: ~/gm-data)"
  $oldHome = (& wsl.exe -d $Old --exec sh -c 'printf %s "$HOME"')
  if ($oldHome -notmatch '^/[A-Za-z0-9/_.-]+$') { throw "unexpected home folder in $Old`: $oldHome" }
  if ($BackupDir -cnotmatch '^[A-Za-z]:\\[A-Za-z0-9 _.,()+\-\\]*$') { throw "Use a plain local folder for -BackupDir." }
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  $file = Join-Path $BackupDir ("gm-data-{0}.tgz" -f (Get-Date -Format "yyyy-MM-dd-HHmm"))
  $cmdFile = Join-Path $env:TEMP "bitbob-migrate-backup.cmd"
  Set-Content -LiteralPath $cmdFile -Encoding ASCII -Value "@wsl.exe -d $Old -u root --exec tar -czf - -C $oldHome --exclude=gm-data/cache --exclude=gm-data/tmp --exclude=gm-data/opencode-sandbox/cache gm-data > `"$file`""
  & cmd.exe /c $cmdFile
  if ($LASTEXITCODE -ne 0 -or (Get-Item $file).Length -lt 1024) { throw "backup failed or is empty: $file" }
  Write-Host ("  {0} ({1:N1} MB) - keep it private, it holds settings.local.json" -f $file, ((Get-Item $file).Length / 1MB))
  $oldLinks = (& wsl.exe -d $Old -u root --exec sh -c "/usr/local/sbin/gm-links list 2>/dev/null || true")

  Step "2/5 Stopping the old stack and distro ($Old stays installed)"
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*link-helper.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  & wsl.exe -d $Old --cd ~/SayGMAgent --exec sh -c "docker compose down 2>/dev/null; true"
  & wsl.exe --terminate $Old

  Step "3/5 Creating the '$New' distro (setup.ps1)"
  & "$PSScriptRoot\setup.ps1" -Source $Source -Distro $New
  if ($LASTEXITCODE -ne 0) { throw "setup.ps1 failed" }
}

Step "4/5 Restoring your data into $New as ~/bitbob-data"
$newHome = (& wsl.exe -d $New --exec sh -c 'printf %s "$HOME"')
if ($newHome -notmatch '^/[A-Za-z0-9/_.-]+$') { throw "unexpected home folder in $New`: $newHome" }
Wsl @("-d", $New, "--cd", "~/BitBob", "--exec", "sh", "-c", "docker compose stop")
# The restore script is written into the distro first (through stdin, as a file: a .cmd line would
# mangle % and quotes), then the backup is piped through cmd, whose pipe is binary-safe.
$restore = @'
set -e
h=$HOME
uid=$(stat -c %u "$h/bitbob-data")
rm -rf "$h/bitbob-data.fresh"
mv "$h/bitbob-data" "$h/bitbob-data.fresh"
tar -xzf - -C "$h"
mv "$h/gm-data" "$h/bitbob-data"
chown -R "$uid:$uid" "$h/bitbob-data"
chmod 700 "$h/bitbob-data"
rm -rf "$h/bitbob-data.fresh"
echo "restored $(du -sh "$h/bitbob-data" | cut -f1) into $h/bitbob-data (uid $uid)"
'@
$restoreFile = Join-Path $env:TEMP "bitbob-restore.sh"
[System.IO.File]::WriteAllText($restoreFile, ($restore -replace "`r`n", "`n"))
$cmdFile2 = Join-Path $env:TEMP "bitbob-migrate-restore.cmd"
# root's HOME is /root; the data lives in the default user's home, so run with HOME set to it
Set-Content -LiteralPath $cmdFile2 -Encoding ASCII -Value @(
  "@type `"$restoreFile`" | wsl.exe -d $New -u root --exec sh -c `"cat > /root/bitbob-restore.sh`"",
  "@type `"$file`" | wsl.exe -d $New -u root --exec env HOME=$newHome sh /root/bitbob-restore.sh"
)
& cmd.exe /c $cmdFile2
if ($LASTEXITCODE -ne 0) { throw "restore failed ($LASTEXITCODE); the backup is still at $file. Re-run with -RestoreFrom `"$file`"" }
# `compose stop` above is an explicit stop, which the restart policy honours: bring them back ourselves
Wsl @("-d", $New, "--cd", "~/BitBob", "--exec", "sh", "-c", "BITBOB_DATA_DIR=`$HOME/bitbob-data BITBOB_HOST_DATA_DIR=`$HOME/bitbob-data BITBOB_LINKS_DIR=/srv/bitbob-links docker compose up -d")
& "$PSScriptRoot\start.ps1" -Distro $New

Step "5/5 Folders that were linked read-only in $Old"
if ($oldLinks) {
  Write-Host $oldLinks
  Write-Host "Link each one again from the BitBob folder menu (Link a folder from this PC...) or with scripts\bitbob-wsl\link.ps1 -Add <path>." -ForegroundColor Yellow
} else { Write-Host "  none" }
Write-Host "`nDone. BitBob: http://localhost:8787  (the desktop app will find it too)" -ForegroundColor Green
Write-Host "When you're happy everything is there:  wsl --unregister $Old   (and delete %LOCALAPPDATA%\GM-WSL)" -ForegroundColor DarkGray
