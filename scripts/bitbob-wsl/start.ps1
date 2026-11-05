<#
  Start the bitbob distro in the background and keep it running (WSL stops idle distros,
  which would stop Docker and BitBob with them). Containers come back on their own.
      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\start.ps1
      ... -InstallAtLogin    also start it every time you log in to Windows
      ... -Stop              shut BitBob and the distro down
#>
param([string]$Distro = "bitbob", [switch]$InstallAtLogin, [switch]$Stop)
$env:WSL_UTF8 = "1"

# Native commands here write to stderr in normal operation (docker's "No swap limit support"),
# and this script checks $LASTEXITCODE itself rather than relying on errors being thrown. Set
# this explicitly: invoked with & from a script that sets Stop (setup.ps1), a child script
# INHERITS that preference, and a stderr warning becomes a terminating NativeCommandError.
$ErrorActionPreference = 'Continue'

$helperScript = Join-Path $PSScriptRoot "link-helper.ps1"
if ($Stop) {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*link-helper.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  & wsl.exe -d $Distro --cd ~/BitBob --exec sh -c "docker compose stop" 2>$null
  & wsl.exe --terminate $Distro
  Write-Host "BitBob stopped."
  return
}

# One plain argument string: Windows PowerShell's Start-Process doesn't quote array items.
# Docker itself is started by the [boot] command in the distro's /etc/wsl.conf.
Start-Process wsl.exe -WindowStyle Hidden -ArgumentList "-d $Distro -u root --exec sleep infinity"
# The link helper (folder picker, Open in Explorer, vault key for BitBob's page). A running one
# is replaced, so a deploy never leaves an old helper behind.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*link-helper.ps1*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -STA -File `"$helperScript`" -Distro $Distro"
Write-Host "bitbob distro starting in the background (this window can be closed afterwards)..."
# -Stop uses `docker compose stop`, an explicit stop that the containers' restart policy honours,
# so they do not come back by themselves: wait for Docker, then bring them up (idempotent).
$dockerUp = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  & wsl.exe -d $Distro --exec docker info *> $null
  if ($LASTEXITCODE -eq 0) { $dockerUp = $true; break }
}
if ($dockerUp) {
  # The data folder is owned by the container's remapped uid; make it traversable so Explorer
  # (\\wsl.localhost, which reads as the distro's default user) can open it. Files inside keep
  # their own modes (settings.local.json and vault.json stay 600).
  & wsl.exe -d $Distro -u root --exec sh -c 'for d in /home/*/bitbob-data; do [ -d "$d" ] && chmod 755 "$d"; done; true' 2>$null
  & wsl.exe -d $Distro --exec sh -c 'test -f ~/BitBob/docker-compose.yml' 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Starting the containers..."
    & wsl.exe -d $Distro --cd ~/BitBob --exec sh -c 'BITBOB_DATA_DIR=$HOME/bitbob-data BITBOB_HOST_DATA_DIR=$HOME/bitbob-data BITBOB_LINKS_DIR=/srv/bitbob-links docker compose up -d 2>&1 | tail -n 4'
  } else {
    Write-Host "No deployed code in the distro yet: run deploy.ps1 (or Deploy in the launcher)." -ForegroundColor Yellow
  }
} else {
  Write-Host "Docker in the $Distro distro didn't start within 60s." -ForegroundColor Yellow
}
$ok = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:8787/api/health"
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
}
if ($ok) { Write-Host "BitBob is up: http://localhost:8787" -ForegroundColor Green }
else { Write-Host "BitBob didn't answer within 90s. Check: wsl -d bitbob --cd ~/BitBob --exec docker compose logs --tail 40" -ForegroundColor Yellow }

if ($InstallAtLogin) {
  $startup = [Environment]::GetFolderPath("Startup")
  $lnk = Join-Path $startup "BitBob.lnk"
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = "powershell.exe"
  $s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Distro $Distro"
  $s.WindowStyle = 7
  $s.Save()
  Write-Host "Added to Startup: $lnk"
}
