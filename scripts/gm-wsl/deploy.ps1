<#
  Ship the code from this Windows checkout into the gm distro and rebuild.
  Your chats and files (~/gm-data inside gm) are not touched.
      powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\deploy.ps1
#>
param([string]$Distro = "gm")
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path

# Top-level entries to ship (never data/, node_modules/, dist/, .git/)
$items = Get-ChildItem -Force -LiteralPath $Repo |
  Where-Object { $_.Name -notin @("data", "node_modules", "dist", ".git") } |
  ForEach-Object { $_.Name }

Write-Host "==> Copying code into $Distro" -ForegroundColor Cyan
# cmd's pipe keeps the tar stream binary-safe (Windows PowerShell's doesn't)
$unpack = "rm -rf ~/SayGMAgent.new && mkdir ~/SayGMAgent.new && tar -xf - -C ~/SayGMAgent.new && sed -i 's/\r`$//' ~/SayGMAgent.new/.env ~/SayGMAgent.new/egress/* && rm -rf ~/SayGMAgent && mv ~/SayGMAgent.new ~/SayGMAgent"
# A .cmd file sidesteps PowerShell's native-argument quoting differences between 5.1 and 7
$cmdFile = Join-Path $env:TEMP "gm-deploy.cmd"
Set-Content -LiteralPath $cmdFile -Encoding ASCII -Value "@tar -cf - --exclude=node_modules --exclude=dist -C `"$Repo`" $($items -join ' ') | wsl.exe -d $Distro --exec sh -c `"$unpack`""
& cmd.exe /c $cmdFile
if ($LASTEXITCODE -ne 0) { throw "copy failed ($LASTEXITCODE)" }

Write-Host "==> Rebuilding" -ForegroundColor Cyan
& wsl.exe -d $Distro --cd ~/SayGMAgent --exec sh -c "GM_DATA_DIR=`$HOME/gm-data docker compose up -d --build --remove-orphans && docker compose restart egress && docker compose ps"
if ($LASTEXITCODE -ne 0) { throw "docker compose failed ($LASTEXITCODE)" }
Write-Host "Deployed. http://localhost:8787" -ForegroundColor Green
