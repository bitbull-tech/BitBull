<#
  Give GM read-only access to a folder on this PC, without copying it.

      powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\link.ps1 -Add "D:\Photos\Horner"
      ... -Add "D:\code\thing" -Name thing     choose the name GM shows (default: the folder name)
      ... -List
      ... -Remove horner

  The agent sees the folder at /links/<name>. It can read and analyse it but cannot change,
  delete, encrypt or run anything in it: the kernel mounts it read-only, no-exec. Only this
  script (run by you, on this PC) can add or remove links; GM and the agent cannot.

  Adding or removing a link restarts the GM container (about 10 seconds); a turn that is
  running at that moment is marked interrupted.

  A linked folder is readable from EVERY chat in this GM (attaching it to a chat only points
  that chat at it), and anything in it may be sent to the model the agent uses. So folders
  that hold keys, passwords or wallets are refused (override with -AllowSecrets). The check
  runs once, when you link: don't save secrets into a linked folder later.
#>
param(
  [string]$Add,
  [string]$Name,
  [string]$Remove,
  [switch]$List,
  [switch]$AllowSecrets,
  [string]$Distro = "gm"
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$helper = "/usr/local/sbin/gm-links"

function Invoke-Root([string[]]$cmd) {
  & wsl.exe -d $Distro -u root --exec @cmd
  if ($LASTEXITCODE -ne 0) { throw "failed: $($cmd -join ' ') ($LASTEXITCODE)" }
}

# Install (or refresh) the helper inside the distro and make links come back after a reboot
function Install-Helper {
  $runner = Join-Path $env:TEMP "gm-links-install.cmd"
  $src = Join-Path $PSScriptRoot "gm-links.sh"
  $tmp = Join-Path $env:TEMP "gm-links.sh"
  [System.IO.File]::WriteAllText($tmp, ((Get-Content -Raw -LiteralPath $src) -replace "`r`n", "`n"))
  Set-Content -LiteralPath $runner -Encoding ASCII -Value "@type `"$tmp`" | wsl.exe -d $Distro -u root --exec sh -c `"cat > $helper && chmod 755 $helper`""
  & cmd.exe /c $runner
  if ($LASTEXITCODE -ne 0) { throw "could not install $helper in the $Distro distro" }
  $boot = "grep -q gm-links /etc/wsl.conf || sed -i 's|^command = service docker start|command = $helper mount-all; service docker start|' /etc/wsl.conf"
  Invoke-Root @("sh", "-c", $boot)
  & wsl.exe -d $Distro -u root --exec grep -q "gm-links mount-all" /etc/wsl.conf
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: couldn't add the links to the distro's boot command (/etc/wsl.conf [boot])." -ForegroundColor Yellow
    Write-Host "Links will be missing after a restart until you run: link.ps1 -List" -ForegroundColor Yellow
  }
}

# Every GM container that mounts the links (the live one and any test stack) holds its own
# copy of the mounts, so all of them restart: a removed link must really be gone.
function Restart-Gm {
  $names = @(& wsl.exe -d $Distro --exec docker ps --filter "name=gm-agent" --format "{{.Names}}" 2>$null) | Where-Object { $_ -match '^gm-agent[A-Za-z0-9_-]*$' }
  $withLinks = @()
  foreach ($n in $names) {
    $m = & wsl.exe -d $Distro --exec docker inspect $n --format "{{range .Mounts}}{{.Destination}} {{end}}" 2>$null
    if ("$m" -match "/links") { $withLinks += $n }
  }
  if (-not $withLinks.Count) {
    Write-Host "No running GM sees links yet: run deploy.ps1 once, then they show up." -ForegroundColor Yellow
    return
  }
  Write-Host "==> Restarting $($withLinks -join ', ') so the change takes effect" -ForegroundColor Cyan
  foreach ($n in $withLinks) {
    & wsl.exe -d $Distro --exec docker restart $n | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "restart of $n failed ($LASTEXITCODE): the old view of the links may still be visible there" }
  }
}

if ($List -or (-not $Add -and -not $Remove)) {
  Install-Helper
  # also re-mounts anything missing (e.g. after a reboot without the boot hook)
  Invoke-Root @($helper, "mount-all")
  Invoke-Root @($helper, "list")
  return
}

if ($Remove) {
  Install-Helper
  Invoke-Root @($helper, "remove", $Remove.ToLower())
  Restart-Gm
  Write-Host "Removed. GM can no longer see it." -ForegroundColor Green
  return
}

# ---------- add ----------
$item = Get-Item -LiteralPath $Add -Force -ErrorAction SilentlyContinue
if (-not $item -or -not $item.PSIsContainer) { throw "Not a folder: $Add" }
$full = $item.FullName.TrimEnd('\')
$lower = $full.ToLower()

# Places that are never linked: whole drives, Windows, programs, your profile root and
# app data, and this repo (its .env holds GM's own keys).
$deny = @(
  $env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData,
  (Join-Path $env:USERPROFILE "AppData"), (Join-Path $env:USERPROFILE ".ssh")
) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\').ToLower() }
if ($full -match '^[A-Za-z]:$') { throw "Refusing to link a whole drive ($full). Link the folder you need." }
if ($full.StartsWith('\\')) { throw "Network (UNC) paths can't be linked: link a folder on a local drive." }
if ($lower -eq $env:USERPROFILE.TrimEnd('\').ToLower()) { throw "Refusing to link your whole profile folder. Link the folder you need." }
foreach ($d in $deny) {
  if ($lower -eq $d -or $lower.StartsWith("$d\")) { throw "Refusing to link a system or app-data folder ($full)." }
}
$repoLower = $Repo.TrimEnd('\').ToLower()
if ($lower -eq $repoLower -or $repoLower.StartsWith("$lower\") -or $lower.StartsWith("$repoLower\")) {
  throw "Refusing to link GM's own repo or a folder containing it: its .env holds GM's keys."
}

# Anything that looks like a key, password store or wallet stops the link
$secretNames = @(".env", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".hippius", ".bittensor", ".npmrc", ".pypirc", ".netrc", ".git-credentials",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json", "secrets.json", "wallet.dat", "login data", "cookies", "key4.db", "logins.json")
$secretPatterns = @("*.pem", "*.key", "*.pfx", "*.p12", "*.ppk", "*.jks", "*.keystore", "*.kdbx", "*.ovpn", "*.wallet", "wallet*.json", "*seed*.txt", "*mnemonic*", ".env.*", "coldkey*", "hotkey*", "id_*")
Write-Host "==> Checking $full for keys and wallets" -ForegroundColor Cyan
$scanErrors = @()
$found = Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable +scanErrors |
  Where-Object {
    $n = $_.Name
    ($secretNames -contains $n.ToLower()) -or ($secretPatterns | Where-Object { $n -like $_ })
  } | Select-Object -First 15
if ($scanErrors.Count -and -not $AllowSecrets) {
  throw "Some of the folder couldn't be read for the check ($($scanErrors[0].TargetObject)). Link a subfolder, or re-run with -AllowSecrets."
}
if ($found -and -not $AllowSecrets) {
  Write-Host "These look like keys, passwords or wallets:" -ForegroundColor Yellow
  $found | ForEach-Object { Write-Host "  $($_.FullName)" }
  throw "Not linked. Move them out of the folder, link a subfolder, or re-run with -AllowSecrets if you are sure."
}

if (-not $Name) { $Name = $item.Name }
$Name = ($Name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
if ($Name.Length -gt 40) { $Name = $Name.Substring(0, 40).Trim('-') }
if (-not $Name) { throw "Give it a name with -Name" }

Install-Helper
Write-Host "==> Linking $full as /links/$Name (read-only)" -ForegroundColor Cyan
Invoke-Root @($helper, "add", $Name, $full)
Restart-Gm
Write-Host ""
Write-Host "Linked. In GM: the folder button in the chat box -> Linked folders -> $Name." -ForegroundColor Green
Write-Host "Remove it with: powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\link.ps1 -Remove $Name" -ForegroundColor DarkGray
