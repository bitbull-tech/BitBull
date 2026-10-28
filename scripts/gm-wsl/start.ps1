<#
  Start the gm distro in the background and keep it running (WSL stops idle distros,
  which would stop Docker and GM with them). Containers come back on their own.
      powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\start.ps1
      ... -InstallAtLogin    also start it every time you log in to Windows
      ... -Stop              shut GM and the distro down
#>
param([string]$Distro = "gm", [switch]$InstallAtLogin, [switch]$Stop)
$env:WSL_UTF8 = "1"

$helperScript = Join-Path $PSScriptRoot "link-helper.ps1"
if ($Stop) {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*link-helper.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  & wsl.exe -d $Distro --cd ~/SayGMAgent --exec sh -c "docker compose stop" 2>$null
  & wsl.exe --terminate $Distro
  Write-Host "GM stopped."
  return
}

# One plain argument string: Windows PowerShell's Start-Process doesn't quote array items.
# Docker itself is started by the [boot] command in the distro's /etc/wsl.conf.
Start-Process wsl.exe -WindowStyle Hidden -ArgumentList "-d $Distro -u root --exec sleep infinity"
# The link helper: lets GM's page open a folder picker on this PC (it exits at once if already running)
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -STA -File `"$helperScript`" -Distro $Distro"
Write-Host "gm distro starting in the background (this window can be closed afterwards)..."
$ok = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:8787/api/health"
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
}
if ($ok) { Write-Host "GM is up: http://localhost:8787" -ForegroundColor Green }
else { Write-Host "GM didn't answer within 90s. Check: wsl -d gm --cd ~/SayGMAgent --exec docker compose logs --tail 40" -ForegroundColor Yellow }

if ($InstallAtLogin) {
  $startup = [Environment]::GetFolderPath("Startup")
  $lnk = Join-Path $startup "GM Agent.lnk"
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = "powershell.exe"
  $s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Distro $Distro"
  $s.WindowStyle = 7
  $s.Save()
  Write-Host "Added to Startup: $lnk"
}
