<#
  Ship the code from this Windows checkout into the bitbob distro and rebuild.
  Your chats and files (~/bitbob-data inside bitbob) are not touched.
      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\deploy.ps1
#>
param([string]$Distro = "bitbob")
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
if ($Distro -notmatch '^[A-Za-z0-9._-]{1,40}$') { throw "bad distro name" }
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path

# Top-level entries to ship (never data/, node_modules/, dist/, .git/, the desktop app or Claude exports)
$items = Get-ChildItem -Force -LiteralPath $Repo |
  Where-Object { $_.Name -notin @("data", "node_modules", "dist", ".git", "desktop", "claude-export") } |
  ForEach-Object { $_.Name }
# These names land in a .cmd line: reject anything cmd could read as syntax (a hostile
# contributor filename must not execute at deploy time). Plain characters only, never a
# leading dash (tar would parse it as an option), then quoted, with -- as end-of-options.
foreach ($n in $items) {
  if ($n -notmatch '^[A-Za-z0-9 _.,()+\-]+$' -or $n.StartsWith("-")) { throw "Refusing to deploy: top-level name '$n' is not safe in a .cmd line" }
}
$quotedItems = ($items | ForEach-Object { '"{0}"' -f $_ }) -join ' '

Write-Host "==> Copying code into $Distro" -ForegroundColor Cyan
# cmd's pipe keeps the tar stream binary-safe (Windows PowerShell's doesn't)
$unpack = "rm -rf ~/BitBob.new && mkdir ~/BitBob.new && tar -xf - -C ~/BitBob.new && sed -i 's/\r`$//' ~/BitBob.new/.env ~/BitBob.new/egress/* && rm -rf ~/BitBob && mv ~/BitBob.new ~/BitBob"
# A .cmd file sidesteps PowerShell's native-argument quoting differences between 5.1 and 7
$cmdFile = Join-Path $env:TEMP "bitbob-deploy.cmd"
Set-Content -LiteralPath $cmdFile -Encoding ASCII -Value "@tar -cf - --exclude=node_modules --exclude=dist -C `"$Repo`" -- $quotedItems | wsl.exe -d $Distro --exec sh -c `"$unpack`""
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
export BITBOB_DATA_DIR=$HOME/bitbob-data BITBOB_HOST_DATA_DIR=$HOME/bitbob-data BITBOB_LINKS_DIR=/srv/bitbob-links
docker compose up -d --build --remove-orphans
if docker compose exec -T egress cat /etc/squid/allowlist.txt 2>/dev/null | diff -q - egress/allowlist.txt >/dev/null 2>&1; then
  docker compose exec -T egress squid -k reconfigure -f /etc/squid/squid.conf 2>/dev/null || docker compose restart egress
else
  echo "==> allowlist changed: recreating the proxy so it sees the new file"
  docker compose up -d --force-recreate egress
fi
docker compose ps
'@ -replace "`r`n", "`n"
$shFile = Join-Path $env:TEMP "bitbob-rebuild.sh"
[System.IO.File]::WriteAllText($shFile, $rebuild)
$runFile = Join-Path $env:TEMP "bitbob-rebuild.cmd"
Set-Content -LiteralPath $runFile -Encoding ASCII -Value "@type `"$shFile`" | wsl.exe -d $Distro --cd ~/BitBob --exec sh"
& cmd.exe /c $runFile
if ($LASTEXITCODE -ne 0) { throw "docker compose failed ($LASTEXITCODE)" }
Write-Host "Deployed. http://localhost:8787" -ForegroundColor Green
