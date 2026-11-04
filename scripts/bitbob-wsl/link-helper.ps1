<#
  Link helper: lets BitBob's web page link and unlink read-only folders with mouse clicks, while
  the choice of folder stays with you, on this PC.

  Runs on Windows (start.ps1 starts it, hidden), listening on http://localhost:8790 only.
  When you press "Link a folder..." in BitBob:
    1. BitBob's page (in your browser, on this PC) asks this helper.
    2. The helper opens a Windows folder picker on this PC. Nothing is linked unless you pick
       a folder there. BitBob never sends a path; it can't, and it isn't asked.
    3. If the folder holds keys, .env files or wallets, a Windows box asks you: link a read-only
       COPY without them (the agent never sees them), link it as it is, or cancel. BitBob's own repo
       is only ever linked as such a copy.
    4. It runs link.ps1 (all the usual checks: read-only mount, verified, BitBob restarted).
  It also opens BitBob's data folders in Explorer (/open: path validated, nothing changed) and
  keeps the vault key (/vault-key: DPAPI-protected file for this Windows user, see server/src/vault.ts).

  Who can reach it: only programs on this PC. The agent can't: its container has no route
  here (the egress proxy refuses private and local addresses). Other web pages can't either:
  requests must come from BitBob's own page (Origin http://localhost:8787 / 8788). Another program
  on this PC could fake that header, but every action still needs you in a Windows dialog:
  linking needs you to pick the folder, removing needs you to press OK. Refresh only re-copies
  a filtered link after a fresh scan for secrets.

      powershell -ExecutionPolicy Bypass -STA -File scripts\bitbob-wsl\link-helper.ps1
#>
param(
  [int]$Port = 8790,
  [int[]]$BitBobPorts = @(8787, 8788),
  [string]$Distro = "bitbob"
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
$linkScript = Join-Path $PSScriptRoot "link.ps1"
Add-Type -AssemblyName System.Windows.Forms

$origins = @()
foreach ($p in $BitBobPorts) { $origins += "http://localhost:$p"; $origins += "http://127.0.0.1:$p" }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  # already running (or the port is taken): nothing to do
  exit 0
}

function Send($ctx, [int]$status, $obj) {
  $res = $ctx.Response
  $origin = $ctx.Request.Headers["Origin"]
  if ($origins -contains $origin) {
    $res.Headers["Access-Control-Allow-Origin"] = $origin
    $res.Headers["Vary"] = "Origin"
    $res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    $res.Headers["Access-Control-Allow-Headers"] = "content-type"
    # Chrome's private-network preflight
    $res.Headers["Access-Control-Allow-Private-Network"] = "true"
  }
  $res.StatusCode = $status
  if ($status -eq 204) { $res.Close(); return }
  $res.ContentType = "application/json"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 5 -Compress))
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.Close()
}

# A small top-most window to own the dialogs, so they open in front of the browser
function New-Owner {
  $f = New-Object System.Windows.Forms.Form
  $f.TopMost = $true
  $f.ShowInTaskbar = $false
  $f.StartPosition = "CenterScreen"
  $f.Size = New-Object System.Drawing.Size(1, 1)
  $f.Opacity = 0
  $f.Show()
  $f.Activate()
  return $f
}

function Invoke-Link([string[]]$argv) {
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $linkScript @argv 2>&1 | Out-String
  return @{ code = $LASTEXITCODE; out = $out.Trim() }
}

function Get-Links {
  $rows = @(& wsl.exe -d $Distro -u root --exec /usr/local/sbin/bitbob-links list 2>$null)
  $list = @()
  foreach ($r in $rows) {
    if ($r -match '^(\S+)\s+(mounted|missing)\s+(live|filtered)\s+(.+)$') { $list += @{ name = $Matches[1]; state = $Matches[2]; mode = $Matches[3]; path = $Matches[4].Trim() } }
  }
  return ,$list
}

function Do-Link {
  $owner = New-Owner
  try {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "BitBob: choose a folder for the agent to READ (it can't change anything in it). Cancel to link nothing."
    $dlg.ShowNewFolderButton = $false
    if ($dlg.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK -or -not $dlg.SelectedPath) {
      return @{ ok = $false; cancelled = $true; message = "No folder chosen." }
    }
    $path = $dlg.SelectedPath
    $r = Invoke-Link @("-Add", $path)
    $found = ($r.out -split "`n" | Where-Object { $_ -match '^\s{2}\S' } | Select-Object -First 12 | Out-String)
    if ($r.code -eq 4) {
      # BitBob's own repo: only ever as a copy without its secrets
      $q = [System.Windows.Forms.MessageBox]::Show($owner,
        "This is BitBob's own repo. It can be linked as a read-only COPY that leaves out its .env, data folder and anything else that looks secret:`n`n" +
        $found + "`nThe agent never sees those files. The copy is refreshed when you press Refresh in BitBob (Settings > Folders).`n`nLink it this way?",
        "BitBob: link this folder?", "OKCancel", "Information", "Button1")
      if ($q -ne [System.Windows.Forms.DialogResult]::OK) { return @{ ok = $false; cancelled = $true; message = "Not linked." } }
      $r = Invoke-Link @("-Add", $path, "-Hide")
    } elseif ($r.code -eq 3) {
      # keys, wallets or unreadable parts found: you decide, here, in Windows
      $q = [System.Windows.Forms.MessageBox]::Show($owner,
        "This folder holds files that look like keys, passwords or wallets (or couldn't be checked):`n`n" + $found +
        "`nYes (recommended): link a read-only COPY without these files. The agent never sees them; press Refresh in BitBob to update the copy.`n" +
        "No: link the folder as it is, including them. The agent could read them and send them to its model.`n" +
        "Cancel: link nothing.",
        "BitBob: link this folder?", "YesNoCancel", "Warning", "Button1")
      if ($q -eq [System.Windows.Forms.DialogResult]::Yes) { $r = Invoke-Link @("-Add", $path, "-Hide") }
      elseif ($q -eq [System.Windows.Forms.DialogResult]::No) { $r = Invoke-Link @("-Add", $path, "-AllowSecrets") }
      else { return @{ ok = $false; cancelled = $true; message = "Not linked." } }
    }
    if ($r.code -ne 0) { return @{ ok = $false; message = (($r.out -split "`n") | Select-Object -Last 3) -join " " } }
    $name = if ($r.out -match 'BITBOB-LINK-NAME: ([a-z0-9-]+)') { $Matches[1] } else { $null }
    return @{ ok = $true; name = $name; path = $path; message = "Linked $path" }
  } finally {
    $owner.Close()
  }
}

function Do-Refresh([string]$name) {
  if ($name -notmatch '^[a-z0-9][a-z0-9-]{0,39}$') { return @{ ok = $false; message = "bad name" } }
  $r = Invoke-Link @("-Refresh", $name)
  if ($r.code -ne 0) { return @{ ok = $false; message = (($r.out -split "`n") | Select-Object -Last 2) -join " " } }
  return @{ ok = $true; message = "Refreshed $name" }
}

function Do-Unlink([string]$name) {
  if ($name -notmatch '^[a-z0-9][a-z0-9-]{0,39}$') { return @{ ok = $false; message = "bad name" } }
  # Asked here, in Windows: the Origin check stops web pages, not other programs on this PC
  $owner = New-Owner
  try {
    $q = [System.Windows.Forms.MessageBox]::Show($owner, "Remove the BitBob link '$name'? BitBob restarts and can no longer read it. Your folder isn't touched.",
      "BitBob: remove link?", "OKCancel", "Question", "Button2")
  } finally { $owner.Close() }
  if ($q -ne [System.Windows.Forms.DialogResult]::OK) { return @{ ok = $false; cancelled = $true; message = "Not removed." } }
  $r = Invoke-Link @("-Remove", $name)
  if ($r.code -ne 0) { return @{ ok = $false; message = (($r.out -split "`n") | Select-Object -Last 2) -join " " } }
  return @{ ok = $true; message = "Removed $name" }
}

# Open a folder of BitBob's data in Explorer. The page sends the path as the distro sees it
# (/home/<user>/bitbob-data/...); it is validated, mapped to \\wsl.localhost\<distro>\... and must
# exist. Nothing is changed, so no dialog. explorer.exe gets the path as one argument.
function Do-Open([string]$p) {
  if ($p -notmatch '^/home/[a-z_][a-z0-9_-]{0,31}/bitbob-data(/[A-Za-z0-9 _.@+-]+)*/?$' -or $p -match '(^|/)\.\.(/|$)') {
    return @{ ok = $false; message = "That path can't be opened from here (only folders under bitbob-data)." }
  }
  $rel = ($p.TrimEnd('/') -replace '/', '\')
  $unc = "\\wsl.localhost\$Distro$rel"
  if (-not (Test-Path -LiteralPath $unc)) { $unc = "\\wsl$\$Distro$rel" }
  if (-not (Test-Path -LiteralPath $unc)) { return @{ ok = $false; message = "Not found or not readable from Windows: $unc. Run start.ps1 once after updating (it makes the data folder readable from this PC)." } }
  Start-Process explorer.exe -ArgumentList @("`"$unc`"")
  return @{ ok = $true; message = "Opened $unc" }
}

# The vault key: 32 random bytes made once, kept under %LOCALAPPDATA%\BitBob\vault.key protected
# with Windows DPAPI for this user only. BitBob's page fetches it to unlock the vault on the
# server; the server never stores it. Only answered to BitBob's own page (Origin).
Add-Type -AssemblyName System.Security
$vaultDir = Join-Path $env:LOCALAPPDATA "BitBob"
$vaultKeyFile = Join-Path $vaultDir "vault.key"
function Get-VaultKey {
  if (Test-Path -LiteralPath $vaultKeyFile) {
    $blob = [System.IO.File]::ReadAllBytes($vaultKeyFile)
    $raw = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else {
    New-Item -ItemType Directory -Force -Path $vaultDir | Out-Null
    $raw = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($raw)
    $blob = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [System.IO.File]::WriteAllBytes($vaultKeyFile, $blob)
  }
  if ($raw.Length -ne 32) { throw "vault key file is damaged" }
  return (($raw | ForEach-Object { $_.ToString("x2") }) -join "")
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $req = $ctx.Request
    $origin = $req.Headers["Origin"]
    # Only BitBob's own page (or a plain local tool with no Origin, for GET) is answered
    if ($origin -and -not ($origins -contains $origin)) { Send $ctx 403 @{ ok = $false; message = "origin not allowed" }; continue }
    if ($req.HttpMethod -eq "OPTIONS") { Send $ctx 204 @{}; continue }
    $path = $req.Url.AbsolutePath
    if ($req.HttpMethod -eq "GET" -and $path -eq "/status") { Send $ctx 200 @{ ok = $true; links = (Get-Links) }; continue }
    if ($req.HttpMethod -eq "GET" -and $path -eq "/vault-key") {
      if (-not $origin) { Send $ctx 403 @{ ok = $false; message = "BitBob's page only" }; continue }
      Send $ctx 200 @{ ok = $true; key = (Get-VaultKey) }; continue
    }
    if ($req.HttpMethod -ne "POST" -or -not $origin) { Send $ctx 405 @{ ok = $false; message = "POST from BitBob's page only" }; continue }
    if ($path -eq "/link") { Send $ctx 200 (Do-Link); continue }
    if ($path -eq "/refresh") {
      $body = (New-Object System.IO.StreamReader($req.InputStream)).ReadToEnd() | ConvertFrom-Json
      Send $ctx 200 (Do-Refresh ([string]$body.name)); continue
    }
    if ($path -eq "/open") {
      $body = (New-Object System.IO.StreamReader($req.InputStream)).ReadToEnd() | ConvertFrom-Json
      Send $ctx 200 (Do-Open ([string]$body.path)); continue
    }
    if ($path -eq "/unlink") {
      $body = (New-Object System.IO.StreamReader($req.InputStream)).ReadToEnd() | ConvertFrom-Json
      Send $ctx 200 (Do-Unlink ([string]$body.name)); continue
    }
    Send $ctx 404 @{ ok = $false; message = "not found" }
  } catch {
    try { Send $ctx 500 @{ ok = $false; message = $_.Exception.Message } } catch {}
  }
}
