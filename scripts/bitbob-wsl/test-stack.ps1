<#
  Run a second, isolated BitBob alongside the live one: its own port, its own containers and
  its own data folder, from whatever is in this checkout right now. For trying a branch
  before merging it, without going anywhere near ~/bitbob-data.

      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\test-stack.ps1            # start on 8788
      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\test-stack.ps1 -Check     # assert the sandbox walls
      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\test-stack.ps1 -Check -Live   # ...on the live stack
      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\test-stack.ps1 -Logs
      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\test-stack.ps1 -Down      # stop, keep its data
      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\test-stack.ps1 -Destroy   # stop and delete its data

  The live stack on 8787 is never touched. Inside the bitbob distro this uses:
      ~/BitBob-test   code      ~/bitbob-data-test   data      compose project "bitbob-test"
#>
param(
  [string]$Distro = "bitbob",
  [int]$Port = 8788,
  [string]$Name = "test",
  [switch]$Down,
  [switch]$Destroy,
  [switch]$Logs,
  [switch]$Check,
  [switch]$Live     # with -Check: check the live stack (bitbob-agent) instead of the test one
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$dir = "~/BitBob-$Name"
$proj = "bitbob-$Name"
# Ask the distro where its default user lives rather than assuming: in the bitbob distro that
# user is not uid 1000 (uid 1000 is the image's own "ubuntu"), and root's $HOME is /root.
$userHome = (& wsl.exe -d $Distro --exec sh -c 'printf %s "$HOME"')
if (-not $userHome) { throw "could not read the default user's home in the $Distro distro" }
$data = "$userHome/bitbob-data-$Name"

# The script goes in through stdin: PowerShell mangles multi-line arguments to `sh -c`.
function Invoke-Sh([string]$script, [string]$cd = $dir, [switch]$AsRoot) {
  $f = Join-Path $env:TEMP "bitbob-$Name-step.sh"
  [System.IO.File]::WriteAllText($f, ($script -replace "`r`n", "`n"))
  $runner = Join-Path $env:TEMP "bitbob-$Name-step.cmd"
  $user = if ($AsRoot) { "-u root " } else { "" }
  Set-Content -LiteralPath $runner -Encoding ASCII -Value "@type `"$f`" | wsl.exe -d $Distro $user--cd $cd --exec sh"
  & cmd.exe /c $runner
  if ($LASTEXITCODE -ne 0) { throw "step failed ($LASTEXITCODE)" }
}

$envLine = "export BITBOB_SUFFIX=-$Name BITBOB_TAG=$Name BITBOB_PORT=$Port BITBOB_DATA_DIR=$data BITBOB_HOST_DATA_DIR=$data BITBOB_LINKS_DIR=/srv/bitbob-links COMPOSE_PROJECT_NAME=$proj"

if ($Logs) {
  Invoke-Sh "$envLine`ndocker compose logs -f --tail 80 bitbob-agent"
  return
}

if ($Check) {
  # Assert the sandbox walls on the running test stack. These are properties of the compose
  # topology rather than of any one line of code, so nothing in `npm test` can catch them
  # breaking: the agent container reaches the network only through squid, and has no name
  # resolution of its own. Verified by hand on 5 Nov 2026 (threat model R4); kept here so a
  # later compose change that quietly gives the agent a routable network fails loudly.
  $target = if ($Live) { "bitbob-agent" } else { "bitbob-agent-$Name" }
  Write-Host "==> Checking the sandbox walls on $target" -ForegroundColor Cyan
  Invoke-Sh @"
$envLine
c=$target
docker inspect -f '{{.State.Status}}' "`$c" >/dev/null 2>&1 || { echo "`$c is not running - start the stack first"; exit 1; }
fail=0
# ck <name> <yes|no: should the command succeed?> <command...>
ck() {
  n=`$1; want=`$2; shift 2
  if "`$@" >/dev/null 2>&1; then got=yes; else got=no; fi
  if [ "`$got" = "`$want" ]; then
    echo "  ok    `$n"
  else
    echo "  FAIL  `$n (expected `$want, got `$got)"; fail=1
  fi
}
ck "no DNS for an arbitrary name"            no  docker exec "`$c" getent hosts example.com
ck "no DNS even for an allowed name"         no  docker exec "`$c" getent hosts github.com
ck "allowed host reachable via the proxy"    yes docker exec "`$c" curl -sS -o /dev/null --max-time 20 https://github.com
ck "host outside the allowlist refused"      no  docker exec "`$c" curl -sS -o /dev/null --max-time 20 https://example.com
ck "no docker socket in the container"       no  docker exec "`$c" test -S /var/run/docker.sock
if [ `$fail -eq 0 ]; then
  echo "sandbox checks passed"
else
  echo "sandbox checks FAILED"; exit 1
fi
"@
  Write-Host "Walls intact." -ForegroundColor Green
  return
}

if ($Down -or $Destroy) {
  Invoke-Sh "$envLine`ndocker compose down --remove-orphans || true"
  if ($Destroy) {
    # The data folder belongs to the remapped container uid, so only root can remove it
    Invoke-Sh -AsRoot -cd "/" "rm -rf '$data' && echo 'data removed: $data'"
    Invoke-Sh "rm -rf $dir && echo 'code removed: $dir'" "~"
    Write-Host "Destroyed." -ForegroundColor Green
  } else {
    Write-Host "Stopped. Its data is kept in $data." -ForegroundColor Green
  }
  return
}

Write-Host "==> Copying this checkout into $dir" -ForegroundColor Cyan
$items = Get-ChildItem -Force -LiteralPath $Repo |
  Where-Object { $_.Name -notin @("data", "node_modules", "dist", ".git") } |
  ForEach-Object { $_.Name }
$unpack = "rm -rf $dir.new && mkdir $dir.new && tar -xf - -C $dir.new && sed -i 's/\r`$//' $dir.new/.env $dir.new/egress/* && rm -rf $dir && mv $dir.new $dir"
$cmdFile = Join-Path $env:TEMP "bitbob-$Name-copy.cmd"
Set-Content -LiteralPath $cmdFile -Encoding ASCII -Value "@tar -cf - --exclude=node_modules --exclude=dist -C `"$Repo`" $($items -join ' ') | wsl.exe -d $Distro --exec sh -c `"$unpack`""
& cmd.exe /c $cmdFile
if ($LASTEXITCODE -ne 0) { throw "copy failed ($LASTEXITCODE)" }

Write-Host "==> Building and starting the $Name stack on 127.0.0.1:$Port" -ForegroundColor Cyan
# Docker here runs with userns-remap, so the data folder must belong to the remapped uid
# that container uid 1000 (node) appears as - exactly what provision.sh does for ~/bitbob-data.
# Only root can hand a folder to another uid, so this step runs as root.
Invoke-Sh -AsRoot -cd "/" @"
set -e
mkdir -p "$data"
start=`$(awk -F: '`$1=="dockremap"{print `$2}' /etc/subuid)
[ -n "`$start" ] || { echo "dockremap subuid range not found: is this the bitbob distro?"; exit 1; }
uid=`$((start + 1000))
chown -R "`$uid:`$uid" "$data"
chmod 700 "$data"
echo "$data owned by remapped uid `$uid"
"@

Invoke-Sh @"
$envLine
docker compose up -d --build --remove-orphans
# `up -d` leaves a container that is already crash-looping alone, so an earlier failed
# attempt would keep failing even once its cause is fixed. Nudge it if it isn't running.
sleep 2
state=`$(docker inspect -f '{{.State.Status}}' bitbob-agent-$Name 2>/dev/null || echo missing)
[ "`$state" = "running" ] || docker compose restart bitbob-agent
docker compose ps
"@

Write-Host ""
Write-Host "Test BitBob:  http://localhost:$Port   (live BitBob is untouched on 8787)" -ForegroundColor Green
Write-Host "Its data: $data inside the $Distro distro, empty until you use it." -ForegroundColor Green
Write-Host "Same APP_TOKEN as the live one, because it was copied from the same .env." -ForegroundColor DarkGray
