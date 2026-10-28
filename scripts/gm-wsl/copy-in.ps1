<#
  Copy a folder from this PC into a GM workspace, fast (no browser upload). The agent then
  works on the copy and can change it freely; your original is never touched.

      powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\copy-in.ps1 -Path "D:\code\roadwolf"
      ... -Project "Game Development"     into that project's workspace (default: the general one)
      ... -Into src                       a folder inside the workspace (default: uploads)
      ... -IncludeBuild                   also copy node_modules, .git, build output
      ... -AllowSecrets                   copy even if it holds keys or wallets

  The copy lands at <workspace>/<Into>/<folder name>. It is written by the container's own
  (unprivileged) user, never by root, so nothing in the folder can plant files elsewhere.
  Unlike uploads made in the browser, it is not mirrored to Hippius.
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Project,
  [string]$Into = "uploads",
  [switch]$IncludeBuild,
  [switch]$AllowSecrets,
  [switch]$Overwrite,
  [string]$Distro = "gm"
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path

# Every call into the distro passes an argument list (no shell, no string building), and
# every value in it has been checked against a strict pattern first. Directory names inside
# GM's data folder are written by the agent's own user, so they are never trusted as-is.
function Root([string[]]$argv) {
  $out = & wsl.exe -d $Distro -u root --exec @argv
  if ($LASTEXITCODE -ne 0) { throw "step failed in the $Distro distro ($LASTEXITCODE)" }
  return $out
}
function As-Gm([string[]]$argv) {
  Root (@("setpriv", "--reuid=$uid", "--regid=$uid", "--clear-groups") + $argv)
}

$item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
if (-not $item -or -not $item.PSIsContainer) { throw "Not a folder: $Path" }
$full = $item.FullName.TrimEnd('\')
if ($full -match '^[A-Za-z]:$') { throw "Refusing to copy a whole drive." }
if ($full.StartsWith('\\')) { throw "Network (UNC) paths aren't supported. Copy from a local folder." }
# The copy runs through cmd.exe, which expands %VARS% and treats & | ^ < > specially. Only
# plain path characters are let through; anything else goes through the browser upload.
if ($full -cnotmatch '^[A-Za-z]:\\[A-Za-z0-9 _.,()+\-\\]*$') {
  throw "The path has characters this script won't pass to cmd.exe (only letters, digits, space and _ . , ( ) + - are allowed). Rename the folder, or use the folder button in GM instead."
}
$repoLower = $Repo.TrimEnd('\').ToLower()
if ($full.ToLower() -eq $repoLower -or $repoLower.StartsWith("$($full.ToLower())\")) {
  throw "Refusing to copy GM's own repo or a folder containing it: its .env holds GM's keys."
}
$leaf = $item.Name
if ($Into -cnotmatch '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$' -or $Into -match '(^|/)\.\.(/|$)') { throw "-Into must be a simple relative folder, e.g. uploads or src/import" }

$skip = @("node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".cache", ".venv", "venv", "__pycache__", ".pytest_cache", "target", ".gradle", ".idea", ".vs")

# Same check as link.ps1: the agent and its model will read everything copied in
$secretNames = @(".env", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".hippius", ".bittensor", ".npmrc", ".pypirc", ".netrc", ".git-credentials",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json", "secrets.json", "wallet.dat", "login data", "cookies", "key4.db", "logins.json")
$secretPatterns = @("*.pem", "*.key", "*.pfx", "*.p12", "*.ppk", "*.jks", "*.keystore", "*.kdbx", "*.ovpn", "*.wallet", "wallet*.json", "*seed*.txt", "*mnemonic*", ".env.*", "coldkey*", "hotkey*", "id_*")
Write-Host "==> Checking $full" -ForegroundColor Cyan
# Case-sensitive skip, like tar's --exclude: anything tar would copy is also scanned.
# Folders count too (.ssh, .aws ...), and a folder that can't be read stops the copy.
$scanErrors = @()
$all = Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable +scanErrors |
  Where-Object { $IncludeBuild -or -not ($_.FullName.Substring($full.Length).Split('\') | Where-Object { $skip -ccontains $_ }) }
if ($scanErrors.Count) { throw "Some of the folder couldn't be read for the check ($($scanErrors[0].TargetObject)). Fix its permissions or copy a subfolder." }
$files = $all | Where-Object { -not $_.PSIsContainer }
$found = $all | Where-Object { $n = $_.Name; ($secretNames -contains $n.ToLower()) -or ($secretPatterns | Where-Object { $n -like $_ }) } | Select-Object -First 15
if ($found -and -not $AllowSecrets) {
  Write-Host "These look like keys, passwords or wallets:" -ForegroundColor Yellow
  $found | ForEach-Object { Write-Host "  $($_.FullName)" }
  throw "Not copied. Move them out, or re-run with -AllowSecrets if you are sure."
}
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
Write-Host ("    {0} files, {1:N1} MB" -f @($files).Count, ($bytes / 1MB))

# Where GM keeps its data, and the uid the container's user appears as in the distro
$userHome = (& wsl.exe -d $Distro --exec sh -c 'printf %s "$HOME"')
if (-not $userHome) { throw "could not read the default user's home in the $Distro distro" }
if ($userHome -notmatch '^/[A-Za-z0-9/_.-]+$') { throw "unexpected home folder in the $Distro distro: $userHome" }
$data = "$userHome/gm-data"
$sub = @(Root @("grep", "^dockremap:", "/etc/subuid")) | Select-Object -First 1
if ("$sub" -notmatch '^dockremap:(\d+):') { throw "could not find the container uid (dockremap) in the $Distro distro" }
$uid = [int64]$Matches[1] + 1000

if ($Project) {
  $slug = ($Project.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
  # same as the server's slug(): cut at 40 without trimming again
  if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40) }
  if (-not $slug) { $slug = "project" }
  # Project folders are <slug>-<6 hex>. Anything else in there is ignored, never used.
  & wsl.exe -d $Distro -u root --exec test -d "$data/projects"
  if ($LASTEXITCODE -ne 0) { throw "GM has no projects yet. Leave out -Project to copy into the general workspace." }
  $dirs = @(Root @("ls", "-1", "$data/projects")) | Where-Object { $_ -cmatch '^[a-z0-9-]{1,40}-[0-9a-f]{6}$' }
  $match = @($dirs | Where-Object { $_.StartsWith("$slug-") -and $_.Length -eq $slug.Length + 7 })
  if ($match.Count -ne 1) {
    Write-Host "Project folders in GM:" -ForegroundColor Yellow
    $dirs | ForEach-Object { Write-Host "  $_" }
    throw "No single project matches '$Project'. Use the project's name as shown in GM."
  }
  $base = "$data/projects/$($match[0])"
} else {
  $base = "$data/workspace"
}
$destParent = "$base/$Into"
$dest = "$destParent/$leaf"

& wsl.exe -d $Distro -u root --exec test -e $dest
if ($LASTEXITCODE -eq 0 -and -not $Overwrite) { throw "$dest already exists in GM. Use -Overwrite to copy over it, or -Into another folder." }
# Create the target as the container's user (never root-owned files in GM's data)
As-Gm @("mkdir", "-p", $destParent) | Out-Null
# The workspace is the agent's own: if it made any part of the path a symlink, stop
$real = ("$(As-Gm @('realpath', '-e', $destParent))").Trim()
if ($real -cne $destParent) { throw "$destParent resolves to $real (a symlink inside GM's data). Not copying; check that folder." }

Write-Host "==> Copying into GM: $dest" -ForegroundColor Cyan
$excl = if ($IncludeBuild) { "" } else { ($skip | ForEach-Object { "--exclude=$_" }) -join " " }
$parent = Split-Path -Parent $full
# cmd's pipe keeps the tar stream binary-safe (Windows PowerShell's doesn't). Unpacked as the
# unprivileged container uid, without owners or permissions from the archive.
$cmdFile = Join-Path $env:TEMP "gm-copy-in.cmd"
Set-Content -LiteralPath $cmdFile -Encoding ASCII -Value "@tar.exe -cf - $excl -C `"$parent`" `"$leaf`" | wsl.exe -d $Distro -u root --exec setpriv --reuid=$uid --regid=$uid --clear-groups tar -xf - --no-same-owner --no-same-permissions -C `"$destParent`""
& cmd.exe /c $cmdFile
if ($LASTEXITCODE -ne 0) { throw "copy failed ($LASTEXITCODE)" }

$count = @(Root @("find", $dest, "-type", "f")).Count
Write-Host ""
Write-Host "Copied $("$count".Trim()) files. In GM: $Into/$leaf in the $(if ($Project) { "'$Project' project" } else { 'general' }) workspace (Files button)." -ForegroundColor Green
Write-Host "Your original folder was not changed." -ForegroundColor DarkGray
