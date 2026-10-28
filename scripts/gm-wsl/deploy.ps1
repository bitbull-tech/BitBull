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
# The allowlist is bind-mounted as a single FILE, so the container holds its inode. This
# deploy replaces the whole directory, which gives the file a new inode: the running proxy
# keeps reading the old, deleted one, and `squid -k reconfigure` changes nothing. So compare
# what the container actually sees and recreate it only when the list has changed:
# reconfigure alone, which doesn't drop connections, stays the common path.
#
# The script goes in through stdin: a multi-line argument to `sh -c` gets mangled by
# PowerShell's native-argument quoting (see docs/HANDOFF.md).
$rebuild = @'
set -e
export GM_DATA_DIR=$HOME/gm-data GM_LINKS_DIR=/srv/gm-links
docker compose up -d --build --remove-orphans
if docker compose exec -T egress cat /etc/squid/allowlist.txt 2>/dev/null | diff -q - egress/allowlist.txt >/dev/null 2>&1; then
  docker compose exec -T egress squid -k reconfigure -f /etc/squid/squid.conf 2>/dev/null || docker compose restart egress
else
  echo "==> allowlist changed: recreating the proxy so it sees the new file"
  docker compose up -d --force-recreate egress
fi
docker compose ps
'@ -replace "`r`n", "`n"
$shFile = Join-Path $env:TEMP "gm-rebuild.sh"
[System.IO.File]::WriteAllText($shFile, $rebuild)
$runFile = Join-Path $env:TEMP "gm-rebuild.cmd"
Set-Content -LiteralPath $runFile -Encoding ASCII -Value "@type `"$shFile`" | wsl.exe -d $Distro --cd ~/SayGMAgent --exec sh"
& cmd.exe /c $runFile
if ($LASTEXITCODE -ne 0) { throw "docker compose failed ($LASTEXITCODE)" }
Write-Host "Deployed. http://localhost:8787" -ForegroundColor Green
