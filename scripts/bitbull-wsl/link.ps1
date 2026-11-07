<#
  Give BitBull read-only access to a folder on this PC, without copying it.

      powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1                  pick a folder in a dialog
      ... -Add "D:\Photos\Horner"
      ... -Add "D:\code\thing" -Name thing     choose the name BitBull shows (default: the folder name)
      ... -List
      ... -Remove horner
      ... -Hide              link a filtered read-only COPY without .env, keys, wallets (and, for BitBull's
                             own repo, data\); refresh it with -Refresh <name>
      ... -InstallMenu       add "Link to BitBull (read-only)" to the right-click menu of folders in Explorer
      ... -UninstallMenu

  The agent sees the folder at /links/<name>. It can read and analyse it but cannot change,
  delete, encrypt or run anything in it: the kernel mounts it read-only, no-exec. Only this
  script (run by you, on this PC) can add or remove links; BitBull and the agent cannot.

  Adding or removing a link restarts the BitBull container (about 10 seconds); a turn that is
  running at that moment is marked interrupted.

  A linked folder is readable from EVERY chat in this BitBull (attaching it to a chat only points
  that chat at it), and anything in it may be sent to the model the agent uses. So folders
  that hold keys, passwords or wallets are not linked as they are: link them with -Hide
  (a read-only copy without those files: the agent never sees them) or, if you are sure,
  -AllowSecrets. BitBull's own repo can only be linked with -Hide.
#>
param(
  [string]$Add,
  [string]$Name,
  [string]$Remove,
  [switch]$List,
  [switch]$Pick,
  [switch]$InstallMenu,
  [switch]$UninstallMenu,
  # keep the window open at the end (used by the Explorer menu)
  [switch]$Pause,
  [switch]$AllowSecrets,
  # link a filtered, read-only COPY that leaves out .env, keys, wallets (and BitBull's data\)
  [switch]$Hide,
  # filtered links only: copy again (after a fresh scan for secrets)
  [string]$Refresh,
  [string]$Distro = "bitbull"
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$helper = "/usr/local/sbin/bitbull-links"

function Invoke-Root([string[]]$cmd) {
  & wsl.exe -d $Distro -u root --exec @cmd
  if ($LASTEXITCODE -ne 0) { throw "failed: $($cmd -join ' ') ($LASTEXITCODE)" }
}

# Places that are never linked at all
function Test-Linkable([string]$full) {
  $lower = $full.ToLower()
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
  $repoData = (Join-Path $Repo "data").ToLower()
  if ($lower -eq $repoData -or $lower.StartsWith("$repoData\")) { throw "Refusing to link BitBull's own data folder." }
}

# Everything in a folder that looks like a key, password store or wallet, as paths relative to
# the folder (folders like .ssh count as a whole). For BitBull's own repo, its .env, data\ and
# .gmtmp\ are added. Windows names are matched case-insensitively here; the copy then leaves out
# exactly these paths (plus the same patterns, in bitbull-links.sh).
function Get-HideList([string]$full) {
  $secretNames = @(".env", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".hippius", ".bittensor", ".npmrc", ".pypirc", ".netrc", ".git-credentials",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json", "secrets.json", "wallet.dat", "login data", "cookies", "key4.db", "logins.json",
    "settings.local.json")
  $secretPatterns = @("*.pem", "*.key", "*.pfx", "*.p12", "*.ppk", "*.jks", "*.keystore", "*.kdbx", "*.ovpn", "*.wallet", "wallet*.json", "*seed*.txt", "*mnemonic*", ".env.*", "coldkey*", "hotkey*", "id_*")
  $templates = @("*.example", "*.sample", "*.template")
  Write-Host "==> Checking $full for keys and wallets" -ForegroundColor Cyan
  $scanErrors = @()
  $found = @(Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable +scanErrors |
    Where-Object {
      $n = $_.Name
      (($secretNames -contains $n.ToLower()) -or ($secretPatterns | Where-Object { $n -like $_ })) -and -not ($templates | Where-Object { $n -like $_ })
    })
  $rel = @($found | ForEach-Object { $_.FullName.Substring($full.Length).TrimStart('\').Replace('\', '/') })
  # BitBull's own repo (this folder, inside it, or containing it)
  $lower = $full.ToLower(); $repoLower = $Repo.TrimEnd('\').ToLower()
  $isRepo = $false
  if ($lower -eq $repoLower -or $repoLower.StartsWith("$lower\")) {
    $isRepo = $true
    $prefix = $Repo.TrimEnd('\').Substring($full.Length).TrimStart('\').Replace('\', '/')
    if ($prefix) { $prefix += "/" }
    $rel += @("$($prefix).env", "$($prefix)data", "$($prefix).gmtmp", "$($prefix)links")
  } elseif ($lower.StartsWith("$repoLower\")) {
    $isRepo = $true
  }
  # Paths a scan couldn't read are hidden too (a copy can't include what wasn't checked)
  $unreadable = @($scanErrors | ForEach-Object { "$($_.TargetObject)" } | Where-Object { $_.ToLower().StartsWith("$lower\") } |
    ForEach-Object { $_.Substring($full.Length).TrimStart('\').Replace('\', '/') })
  $rel += $unreadable
  return @{ Paths = @($rel | Where-Object { $_ } | Sort-Object -Unique -CaseSensitive); Repo = $isRepo; Unreadable = $unreadable.Count; Found = $found }
}

function Show-Found($scan) {
  Write-Host "These look like keys, passwords or wallets (or couldn't be checked):" -ForegroundColor Yellow
  $scan.Paths | Select-Object -First 15 | ForEach-Object { Write-Host "  $_" }
  if ($scan.Paths.Count -gt 15) { Write-Host "  ... and $($scan.Paths.Count - 15) more" }
}

# The hide list goes to bitbull-links on stdin, UTF-8, one path per line (never on a command line)
function Send-HideList([string[]]$paths, [string[]]$argv) {
  # local to this function: PowerShell encodes what it pipes to a native program with this
  $OutputEncoding = New-Object System.Text.UTF8Encoding $false
  (@($paths) -join "`n") + "`n" | & wsl.exe -d $Distro -u root --exec @argv
  if ($LASTEXITCODE -ne 0) { throw "failed: $($argv -join ' ') ($LASTEXITCODE)" }
}

# Install (or refresh) the helper inside the distro and make links come back after a reboot
function Install-Helper {
  $runner = Join-Path $env:TEMP "bitbull-links-install.cmd"
  $src = Join-Path $PSScriptRoot "bitbull-links.sh"
  $tmp = Join-Path $env:TEMP "bitbull-links.sh"
  [System.IO.File]::WriteAllText($tmp, ((Get-Content -Raw -LiteralPath $src) -replace "`r`n", "`n"))
  Set-Content -LiteralPath $runner -Encoding ASCII -Value "@type `"$tmp`" | wsl.exe -d $Distro -u root --exec sh -c `"cat > $helper && chmod 755 $helper`""
  & cmd.exe /c $runner
  if ($LASTEXITCODE -ne 0) { throw "could not install $helper in the $Distro distro" }
  $boot = "grep -q bitbull-links /etc/wsl.conf || sed -i 's|^command = service docker start|command = $helper mount-all; service docker start|' /etc/wsl.conf"
  Invoke-Root @("sh", "-c", $boot)
  & wsl.exe -d $Distro -u root --exec grep -q "bitbull-links mount-all" /etc/wsl.conf
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: couldn't add the links to the distro's boot command (/etc/wsl.conf [boot])." -ForegroundColor Yellow
    Write-Host "Links will be missing after a restart until you run: link.ps1 -List" -ForegroundColor Yellow
  }
}

# Every BitBull container that mounts the links (the live one and any test stack) holds its own
# copy of the mounts, so all of them restart: a removed link must really be gone.
function Restart-BitBull {
  $names = @(& wsl.exe -d $Distro --exec docker ps --filter "name=bitbull-agent" --format "{{.Names}}" 2>$null) | Where-Object { $_ -match '^bitbull-agent[A-Za-z0-9_-]*$' }
  $withLinks = @()
  foreach ($n in $names) {
    $m = & wsl.exe -d $Distro --exec docker inspect $n --format "{{range .Mounts}}{{.Destination}} {{end}}" 2>$null
    if ("$m" -match "/links") { $withLinks += $n }
  }
  if (-not $withLinks.Count) {
    Write-Host "No running BitBull sees links yet: run deploy.ps1 once, then they show up." -ForegroundColor Yellow
    return
  }
  Write-Host "==> Restarting $($withLinks -join ', ') so the change takes effect" -ForegroundColor Cyan
  foreach ($n in $withLinks) {
    & wsl.exe -d $Distro --exec docker restart $n | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "restart of $n failed ($LASTEXITCODE): the old view of the links may still be visible there" }
  }
}

function Main {
  $menuKeys = @("HKCU:\Software\Classes\Directory\shell\GMAgentLink", "HKCU:\Software\Classes\Directory\Background\shell\GMAgentLink")
  if ($InstallMenu) {
    # Right-click a folder (or inside one) -> "Link to BitBull (read-only)". Only for you (HKCU), and
    # it just runs this script, which shows what it is doing and asks nothing of BitBull.
    $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Add `"%V`" -Pause"
    foreach ($k in $menuKeys) {
      New-Item -Path "$k\command" -Force | Out-Null
      Set-ItemProperty -Path $k -Name "MUIVerb" -Value "Link to BitBull (read-only)"
      Set-ItemProperty -Path $k -Name "Icon" -Value "imageres.dll,-1028"
      Set-ItemProperty -Path "$k\command" -Name "(default)" -Value $cmd
    }
    Write-Host "Added 'Link to BitBull (read-only)' to the right-click menu of folders." -ForegroundColor Green
    Write-Host "On Windows 11 it is under 'Show more options' (or Shift+right-click)." -ForegroundColor DarkGray
    return
  }
  if ($UninstallMenu) {
    foreach ($k in $menuKeys) { if (Test-Path $k) { Remove-Item -Recurse -Force $k } }
    Write-Host "Removed the right-click menu entry." -ForegroundColor Green
    return
  }

  if ($Pick -or (-not $Add -and -not $Remove -and -not $List -and -not $Refresh)) {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "Choose a folder for BitBull to read (read-only: BitBull can't change it)"
    $dlg.ShowNewFolderButton = $false
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK -or -not $dlg.SelectedPath) {
      Write-Host "No folder chosen." -ForegroundColor Yellow
      return
    }
    $Add = $dlg.SelectedPath
  }

  if ($List) {
    Install-Helper
    # also re-mounts anything missing (e.g. after a reboot without the boot hook)
    Invoke-Root @($helper, "mount-all")
    Invoke-Root @($helper, "list")
    return
  }

  if ($Refresh) {
    $Refresh = $Refresh.ToLower()
    Install-Helper
    $row = @(& wsl.exe -d $Distro -u root --exec $helper list) | Where-Object { $_ -match "^$([regex]::Escape($Refresh))\s" } | Select-Object -First 1
    if ($row -notmatch '^\S+\s+\S+\s+filtered\s+(.+)$') { throw "$Refresh is not a filtered link (live links are always current)." }
    $full = $Matches[1].Trim()
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw "The folder is gone: $full" }
    # Scan again first: anything secret added since the last copy stays hidden too
    $scan = Get-HideList $full
    Write-Host "==> Refreshing $Refresh from $full ($($scan.Paths.Count) path(s) hidden)" -ForegroundColor Cyan
    Send-HideList $scan.Paths @($helper, "refresh", $Refresh)
    Write-Host "Refreshed. BitBull sees the new copy now (no restart needed)." -ForegroundColor Green
    return
  }

  if ($Remove) {
    Install-Helper
    Invoke-Root @($helper, "remove", $Remove.ToLower())
    Restart-BitBull
    Write-Host "Removed. BitBull can no longer see it." -ForegroundColor Green
    return
  }

  # ---------- add ----------
  $item = Get-Item -LiteralPath $Add -Force -ErrorAction SilentlyContinue
  if (-not $item -or -not $item.PSIsContainer) { throw "Not a folder: $Add" }
  $full = $item.FullName.TrimEnd('\')
  Test-Linkable $full
  $scan = Get-HideList $full

  $mode = "live"
  if ($scan.Repo) {
    # BitBull's own repo: only ever as a filtered copy, without .env, data\ and other secrets
    if ($AllowSecrets -and -not $Hide) { throw "BitBull's own repo can only be linked with its secrets hidden (-Hide)." }
    if (-not $Hide) {
      $script:exitCode = 4   # link-helper.ps1: asks to confirm hiding, then retries with -Hide
      Show-Found $scan
      throw "This is BitBull's own repo (or contains it). It can be linked as a filtered copy without .env, data\ and the files above: re-run with -Hide."
    }
    $mode = "filtered"
  } elseif ($scan.Paths.Count -or $scan.Unreadable) {
    if ($Hide) { $mode = "filtered" }
    elseif (-not $AllowSecrets) {
      $script:exitCode = 3   # link-helper.ps1 asks: hide them (filtered copy), link all, or cancel
      Show-Found $scan
      throw "Not linked. Re-run with -Hide to link a copy without these (recommended), or -AllowSecrets to link everything."
    }
  } elseif ($Hide) {
    $mode = "filtered"
  }

  $chosen = [bool]$Name
  if (-not $Name) { $Name = $item.Name }
  $Name = ($Name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
  if ($Name.Length -gt 36) { $Name = $Name.Substring(0, 36).Trim('-') }
  if (-not $Name) { $Name = "folder" }

  Install-Helper
  # A name you didn't choose yourself gets -2, -3 ... if it is already taken
  $taken = @(& wsl.exe -d $Distro -u root --exec $helper list) | ForEach-Object { ($_ -split '\s+')[0] }
  if ($taken -contains $Name) {
    if ($chosen) { throw "A link called $Name already exists. Remove it first, or choose another -Name." }
    $n = 2
    while ($taken -contains "$Name-$n") { $n++ }
    $Name = "$Name-$n"
  }
  if ($mode -eq "filtered") {
    Write-Host "==> Linking $full as /links/${Name}: a read-only copy without $($scan.Paths.Count) hidden path(s)" -ForegroundColor Cyan
    Send-HideList $scan.Paths @($helper, "add-filtered", $Name, $full)
  } else {
    Write-Host "==> Linking $full as /links/$Name (read-only)" -ForegroundColor Cyan
    Invoke-Root @($helper, "add", $Name, $full)
  }
  Restart-BitBull
  Write-Host ""
  Write-Host "BITBULL-LINK-NAME: $Name"
  Write-Host "Linked. In BitBull: the folder button in the chat box -> Linked folders -> $Name." -ForegroundColor Green
  if ($mode -eq "filtered") {
    Write-Host "It is a copy: after changing files, press Refresh in Settings -> Folders (or link.ps1 -Refresh $Name)." -ForegroundColor DarkGray
  }
  Write-Host "Remove it with: powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -Remove $Name" -ForegroundColor DarkGray
}

$failed = $false
$script:exitCode = 1
try { Main }
catch {
  Write-Host ""
  Write-Host $_.Exception.Message -ForegroundColor Red
  $failed = $true
}
finally {
  if ($Pause) { Read-Host "Press Enter to close" | Out-Null }
}
if ($failed) { exit $script:exitCode }
