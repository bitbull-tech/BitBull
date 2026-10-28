<#
  Link helper: lets GM's web page link and unlink read-only folders with mouse clicks, while
  the choice of folder stays with you, on this PC.

  Runs on Windows (start.ps1 starts it, hidden), listening on http://localhost:8790 only.
  When you press "Link a folder..." in GM:
    1. GM's page (in your browser, on this PC) asks this helper.
    2. The helper opens a Windows folder picker on this PC. Nothing is linked unless you pick
       a folder there. GM never sends a path; it can't, and it isn't asked.
    3. If the folder looks like it holds keys or wallets, a Windows Yes/No box asks you first.
    4. It runs link.ps1 (all the usual checks: read-only mount, verified, GM restarted).

  Who can reach it: only programs on this PC. The agent can't: its container has no route
  here (the egress proxy refuses private and local addresses). Other web pages can't either:
  requests must come from GM's own page (Origin http://localhost:8787 / 8788), and even
  then the worst they can do is open the picker or remove a link, never choose a folder.

      powershell -ExecutionPolicy Bypass -STA -File scripts\gm-wsl\link-helper.ps1
#>
param(
  [int]$Port = 8790,
  [int[]]$GmPorts = @(8787, 8788),
  [string]$Distro = "gm"
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"
$linkScript = Join-Path $PSScriptRoot "link.ps1"
Add-Type -AssemblyName System.Windows.Forms

$origins = @()
foreach ($p in $GmPorts) { $origins += "http://localhost:$p"; $origins += "http://127.0.0.1:$p" }

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
  $rows = @(& wsl.exe -d $Distro -u root --exec /usr/local/sbin/gm-links list 2>$null)
  $list = @()
  foreach ($r in $rows) {
    if ($r -match '^(\S+)\s+(mounted|missing)\s+(.+)$') { $list += @{ name = $Matches[1]; state = $Matches[2]; path = $Matches[3].Trim() } }
  }
  return ,$list
}

function Do-Link {
  $owner = New-Owner
  try {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "GM: choose a folder for the agent to READ (it can't change anything in it). Cancel to link nothing."
    $dlg.ShowNewFolderButton = $false
    if ($dlg.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK -or -not $dlg.SelectedPath) {
      return @{ ok = $false; cancelled = $true; message = "No folder chosen." }
    }
    $path = $dlg.SelectedPath
    $r = Invoke-Link @("-Add", $path)
    if ($r.code -eq 3) {
      # keys, wallets or unreadable parts found: you decide, here, in Windows
      $q = [System.Windows.Forms.MessageBox]::Show($owner,
        "This folder looks like it holds keys, passwords or wallets (or parts of it couldn't be checked):`n`n" +
        ($r.out -split "`n" | Where-Object { $_ -match '^\s{2}\S' } | Select-Object -First 10 | Out-String) +
        "`nThe agent could read them and send them to its model. Link it anyway?",
        "GM: link this folder?", "YesNo", "Warning", "Button2")
      if ($q -ne [System.Windows.Forms.DialogResult]::Yes) { return @{ ok = $false; cancelled = $true; message = "Not linked: you said no." } }
      $r = Invoke-Link @("-Add", $path, "-AllowSecrets")
    }
    if ($r.code -ne 0) { return @{ ok = $false; message = (($r.out -split "`n") | Select-Object -Last 3) -join " " } }
    $name = if ($r.out -match '/links/([a-z0-9-]+) \(read-only\)') { $Matches[1] } else { $null }
    return @{ ok = $true; name = $name; path = $path; message = "Linked $path" }
  } finally {
    $owner.Close()
  }
}

function Do-Unlink([string]$name) {
  if ($name -notmatch '^[a-z0-9][a-z0-9-]{0,39}$') { return @{ ok = $false; message = "bad name" } }
  $r = Invoke-Link @("-Remove", $name)
  if ($r.code -ne 0) { return @{ ok = $false; message = (($r.out -split "`n") | Select-Object -Last 2) -join " " } }
  return @{ ok = $true; message = "Removed $name" }
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $req = $ctx.Request
    $origin = $req.Headers["Origin"]
    # Only GM's own page (or a plain local tool with no Origin, for GET) is answered
    if ($origin -and -not ($origins -contains $origin)) { Send $ctx 403 @{ ok = $false; message = "origin not allowed" }; continue }
    if ($req.HttpMethod -eq "OPTIONS") { Send $ctx 204 @{}; continue }
    $path = $req.Url.AbsolutePath
    if ($req.HttpMethod -eq "GET" -and $path -eq "/status") { Send $ctx 200 @{ ok = $true; links = (Get-Links) }; continue }
    if ($req.HttpMethod -ne "POST" -or -not $origin) { Send $ctx 405 @{ ok = $false; message = "POST from GM's page only" }; continue }
    if ($path -eq "/link") { Send $ctx 200 (Do-Link); continue }
    if ($path -eq "/unlink") {
      $body = (New-Object System.IO.StreamReader($req.InputStream)).ReadToEnd() | ConvertFrom-Json
      Send $ctx 200 (Do-Unlink ([string]$body.name)); continue
    }
    Send $ctx 404 @{ ok = $false; message = "not found" }
  } catch {
    try { Send $ctx 500 @{ ok = $false; message = $_.Exception.Message } } catch {}
  }
}
