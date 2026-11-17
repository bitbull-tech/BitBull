<#
  Link helper: lets BitBull's web page link and unlink read-only folders with mouse clicks, while
  the choice of folder stays with you, on this PC.

  Runs on Windows (start.ps1 starts it, hidden), listening on http://localhost:8790 only.
  When you press "Link a folder..." in BitBull:
    1. BitBull's page (in your browser, on this PC) asks this helper.
    2. The helper opens a Windows folder picker on this PC. Nothing is linked unless you pick
       a folder there. BitBull never sends a path; it can't, and it isn't asked.
    3. If the folder holds keys, .env files or wallets, a Windows box asks you: link a read-only
       COPY without them (the agent never sees them), link it as it is, or cancel. BitBull's own repo
       is only ever linked as such a copy.
    4. It runs link.ps1 (all the usual checks: read-only mount, verified, BitBull restarted).
  It also opens BitBull's data folders in Explorer (/open: path validated, nothing changed) and
  keeps the vault key (/vault-key: DPAPI-protected file for this Windows user, see server/src/vault.ts).

  Who can reach it: only programs on this PC. The agent can't: its container has no route
  here (the egress proxy refuses private and local addresses). Other web pages can't either:
  requests must come from BitBull's own page (Origin http://localhost:8787 / 8788). Another program
  on this PC could fake that header, but every action still needs you in a Windows dialog:
  linking needs you to pick the folder, removing needs you to press OK. Refresh only re-copies
  a filtered link after a fresh scan for secrets.

  Changing files in a linked folder (folder-apply.ps1 has the rules):
    - BitBull only ever sees a linked folder read-only. A change reaches it one way: the agent
      proposes it, BitBull's page shows you the files and the diff, and when you approve the page
      asks this helper to copy the staged files in (/apply). The helper checks each file against
      the hash you were shown and refuses protected paths, whatever it is asked.
    - Only folders you allowed changes in are written to (/grant: a Windows box asks you). Deleting
      is a second, separate permission. Both are kept in %LOCALAPPDATA%\BitBull\folder-access.json,
      on this PC, where nothing in the sandbox can reach, and are listed in Settings > Folders,
      where you can take them away again (/revoke: no question asked, it only removes access).
    - Putting a change on a new git branch (mode "branch") leaves your working files alone. With
      no write permission on the folder, a Windows box asks you each time.

      powershell -ExecutionPolicy Bypass -STA -File scripts\bitbull-wsl\link-helper.ps1
#>
param(
  [int]$Port = 8790,
  [int[]]$BitBullPorts = @(8787, 8788),
  [string]$Distro = "bitbull"
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"

# This runs with no window, so a helper that fails to start used to fail without a word and
# BitBull's page could only say "the helper isn't answering". It now keeps a short log
# (%LOCALAPPDATA%\BitBull\link-helper.log: when it started, and why it stopped), which start.ps1
# shows when the helper doesn't come up. Messages only, never request bodies or the vault key.
$helperLog = Join-Path (Join-Path $env:LOCALAPPDATA "BitBull") "link-helper.log"
function Write-HelperLog([string]$m) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $helperLog) | Out-Null
    $old = @()
    if (Test-Path -LiteralPath $helperLog) { $old = @(Get-Content -LiteralPath $helperLog -Tail 200) }
    $line = "{0}  {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $m
    Set-Content -LiteralPath $helperLog -Value ($old + $line) -Encoding UTF8
  } catch {}
}
trap {
  Write-HelperLog ("stopped with an error: " + $_.Exception.Message + " (line " + $_.InvocationInfo.ScriptLineNumber + ")")
  break
}
$linkScript = Join-Path $PSScriptRoot "link.ps1"
. (Join-Path $PSScriptRoot "folder-apply.ps1")
$bitbullLocal = Join-Path $env:LOCALAPPDATA "BitBull"
$grantFile = Join-Path $bitbullLocal "folder-access.json"
$backupRoot = Join-Path $bitbullLocal "folder-backups"
Add-Type -AssemblyName System.Windows.Forms

$origins = @()
foreach ($p in $BitBullPorts) { $origins += "http://localhost:$p"; $origins += "http://127.0.0.1:$p" }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  # already running (or the port is taken): nothing to do
  Write-HelperLog ("not started: port $Port is in use (another helper is already running, or another program has the port). " + $_.Exception.Message)
  exit 0
}
Write-HelperLog ("started on port $Port (PowerShell " + $PSVersionTable.PSVersion.ToString() + ", distro $Distro)")

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
  $rows = @(& wsl.exe -d $Distro -u root --exec /usr/local/sbin/bitbull-links list 2>$null)
  $list = @()
  foreach ($r in $rows) {
    if ($r -match '^(\S+)\s+(mounted|missing)\s+(live|filtered)\s+(.+)$') {
      # write/delete: allowed for at least one project; grants: which project may do what
      $l = @{ name = $Matches[1]; state = $Matches[2]; mode = $Matches[3]; path = $Matches[4].Trim(); write = $false; delete = $false; grants = @{} }
      $all = Get-BitBullGrants $grantFile
      if ($all.ContainsKey($l.name)) {
        foreach ($pk in @($all[$l.name].projects.Keys)) {
          $g = Get-BitBullGrantFor $all $l.name $l.path $pk
          if ($g -and $g.write) {
            $l.grants[$pk] = @{ write = $true; delete = [bool]$g.delete; since = $g.since }
            $l.write = $true
            if ($g.delete) { $l.delete = $true }
          }
        }
      }
      $list += $l
    }
  }
  return ,$list
}

# The permission you gave one project for a link, if it still names the same folder (a link name
# reused for another folder starts with none). The project is the one the page says the chat is
# in: the page is BitBull's own (Origin-checked), and nothing in the sandbox can reach this helper.
function Get-Grant($link, [string]$project) {
  return (Get-BitBullGrantFor (Get-BitBullGrants $grantFile) $link.name $link.path $project)
}
$projectRe = '^[A-Za-z0-9_-]{1,80}$'

function Find-Link([string]$name) {
  if ($name -notmatch '^[a-z0-9][a-z0-9-]{0,39}$') { return $null }
  foreach ($l in (Get-Links)) { if ($l.name -eq $name) { return $l } }
  return $null
}

function Do-Grant([string]$name, [string]$what, [string]$project, [string]$projectName) {
  $link = Find-Link $name
  if (-not $link) { return @{ ok = $false; message = "No such link." } }
  if ($what -ne "write" -and $what -ne "delete") { return @{ ok = $false; message = "bad request" } }
  if ($project -notmatch $projectRe) { return @{ ok = $false; message = "This BitBull page is older than the helper on this PC. Reload the page and try again." } }
  # shown in the box so you can see which project you are allowing; it is only a label
  $label = (($projectName -replace '[\x00-\x1f]', ' ').Trim())
  if ($label.Length -gt 60) { $label = $label.Substring(0, 60) }
  if (-not $label) { $label = $(if ($project -eq "general") { "chats outside a project" } else { "this project" }) }
  $all = Get-BitBullGrants $grantFile
  $cur = Get-Grant $link $project
  if ($what -eq "delete" -and -not ($cur -and $cur.write)) { return @{ ok = $false; message = "Allow changes in this folder first." } }
  $owner = New-Owner
  try {
    if ($what -eq "write") {
      $q = [System.Windows.Forms.MessageBox]::Show($owner,
        "Allow BitBull to change files in this folder, for $label?`n`n$($link.path)`n`n" +
        "This is for that project's chats only. Another project using the same folder asks again.`n`n" +
        "From now on, changes the agent makes for this folder in a chat on this PC are written here straight away. Each one is listed in the chat with its diff and an Undo, and what it replaces is backed up first.`n`n" +
        "Never written, whatever is approved: .git (hooks, config), .vscode, .idea, .github\workflows, shell start-up files, .env files, programs and shortcuts.`n" +
        "Deleting files stays off unless you allow it separately. Scheduled runs and Telegram can't change anything here.`n`n" +
        "You can take this away again in BitBull: Settings > Folders.",
        "BitBull: allow changes in this folder?", "OKCancel", "Warning", "Button2")
    } else {
      $q = [System.Windows.Forms.MessageBox]::Show($owner,
        "Also allow BitBull to DELETE files in this folder, for $label?`n`n$($link.path)`n`n" +
        "Only files in a change you approve are deleted, and they go to the Recycle Bin, with a copy kept in BitBull's backup folder. Protected paths (.git and the rest) are never deleted.",
        "BitBull: allow deleting in this folder?", "OKCancel", "Warning", "Button2")
    }
  } finally { $owner.Close() }
  if ($q -ne [System.Windows.Forms.DialogResult]::OK) { return @{ ok = $false; cancelled = $true; message = "Not changed." } }
  # a grant recorded for another folder under this name is not kept
  if (-not $all.ContainsKey($link.name) -or ([string]$all[$link.name].path).TrimEnd('\').ToLowerInvariant() -ne $link.path.TrimEnd('\').ToLowerInvariant()) { $all[$link.name] = @{ path = $link.path; projects = @{} } }
  if ($what -eq "write") { $all[$link.name].projects[$project] = @{ write = $true; delete = $false; since = (Get-Date).ToString("yyyy-MM-dd") } }
  else { $all[$link.name].projects[$project].delete = $true }
  Save-BitBullGrants $grantFile $all
  return @{ ok = $true; message = "Allowed." }
}

# Taking access away needs no question: it can only make BitBull able to do less.
# With a project: that project only. Without one: every project (Settings, and removing the link).
function Do-Revoke([string]$name, [string]$what, [string]$project) {
  if ($name -notmatch '^[a-z0-9][a-z0-9-]{0,39}$') { return @{ ok = $false; message = "bad name" } }
  if ($project -and $project -notmatch $projectRe) { return @{ ok = $false; message = "bad request" } }
  $all = Get-BitBullGrants $grantFile
  if ($all.ContainsKey($name)) {
    $keys = @($all[$name].projects.Keys)
    if ($project) { $keys = @($keys | Where-Object { $_ -eq $project }) }
    foreach ($k in $keys) {
      if ($what -eq "delete") { $all[$name].projects[$k].delete = $false } else { $all[$name].projects.Remove($k) }
    }
    if ($all[$name].projects.Count -eq 0) { $all.Remove($name) }
    Save-BitBullGrants $grantFile $all
  }
  return @{ ok = $true; message = "Removed." }
}

# BitBull's staged files, as this PC reads them. The page sends the path as the distro sees it.
function Resolve-Staging([string]$p) {
  if ($p -notmatch '^/home/[a-z_][a-z0-9_-]{0,31}/bitbull-data/folder-changes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { return $null }
  $rel = ($p -replace '/', '\')
  $unc = "\\wsl.localhost\$Distro$rel"
  if (-not (Test-Path -LiteralPath $unc)) { $unc = "\\wsl$\$Distro$rel" }
  if (-not (Test-Path -LiteralPath $unc -PathType Container)) { return $null }
  return $unc
}

function Do-Apply($body) {
  $link = Find-Link ([string]$body.name)
  if (-not $link) { return @{ ok = $false; message = "No such link." } }
  if ($link.state -ne "mounted") { return @{ ok = $false; message = "That folder isn't linked right now." } }
  if (-not (Test-Path -LiteralPath $link.path -PathType Container)) { return @{ ok = $false; message = "The folder is not there: $($link.path)" } }
  $staging = Resolve-Staging ([string]$body.staging)
  if (-not $staging) { return @{ ok = $false; message = "The staged files can't be read from this PC. Run start.ps1 once after updating (it makes BitBull's data folder readable from here), then try again." } }
  $manifest = @($body.manifest | Where-Object { $_ })
  $deletes = @($body.deletes | Where-Object { $_ } | ForEach-Object { [string]$_ })
  $project = [string]$body.project
  $grant = Get-Grant $link $project
  $mode = [string]$body.mode
  # what the agent read, per file, so a file changed since is not overwritten
  $expect = $null
  if ($body.expect) {
    $expect = @{}
    foreach ($e in $body.expect.PSObject.Properties) { $expect[$e.Name] = [string]$e.Value }
  }

  if ($mode -eq "branch") {
    if (-not ($grant -and $grant.write)) {
      # no standing permission: a branch touches none of your files, but you still say yes, here
      $owner = New-Owner
      try {
        $q = [System.Windows.Forms.MessageBox]::Show($owner,
          "Create the branch $([string]$body.branch) in a git repo under`n`n$($link.path)`n`nwith the $($manifest.Count + $deletes.Count) file change(s) you just looked at in BitBull?`n`nYour working files and your current branch are not touched.",
          "BitBull: create a branch?", "OKCancel", "Question", "Button1")
      } finally { $owner.Close() }
      if ($q -ne [System.Windows.Forms.DialogResult]::OK) { return @{ ok = $false; cancelled = $true; message = "Not created." } }
    }
    return (Invoke-BitBullBranch -Root $link.path -Staging $staging -Manifest $manifest -Deletes $deletes -Branch ([string]$body.branch) -Message ([string]$body.message))
  }

  if (-not ($grant -and $grant.write)) { return @{ ok = $false; message = "Changes aren't allowed in this folder for this project. Allow them from the change's card or the Resources panel (or put the change on a branch)." } }
  # BitBull reads a copy of this folder without its secrets. A file it believes is new but that is
  # in your folder is one it was never shown (a hidden key or .env, or something added since the
  # last refresh): it is not overwritten blind.
  if ($link.mode -eq "filtered") {
    foreach ($m in $manifest) {
      if ($m.new -and (Test-Path -LiteralPath ([System.IO.Path]::Combine($link.path, ([string]$m.path).Replace('/', '\'))))) {
        return @{ ok = $false; message = "$([string]$m.path) is already in your folder, but BitBull's copy doesn't have it (it is hidden as a secret, or was added since the last refresh), so it was not overwritten. Refresh the folder in BitBull and ask again." }
      }
    }
  }
  $backup = Join-Path $backupRoot ((Get-Date).ToString("yyyyMMdd-HHmmss") + "-" + $link.name)
  $r = Invoke-BitBullApply -Root $link.path -Staging $staging -Manifest $manifest -Deletes $deletes -AllowDelete ([bool]$grant.delete) -BackupDir $backup -Expect $expect
  # keep the thirty most recent backups
  if ($r.backup) { $r.backupId = (Split-Path -Leaf $r.backup) }
  # a copy without its secrets is what BitBull reads: copy it again so it shows what was written
  if ($r.ok -and $link.mode -eq "filtered") { $r.refreshed = [bool](Do-Refresh $link.name).ok }
  try {
    @(Get-ChildItem -LiteralPath $backupRoot -File -Filter "*.json*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -Skip 60) | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    @(Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -Skip 30) | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  } catch {}
  return $r
}

# Undo one apply, by the name of its backup folder (which the page was given when it applied).
function Do-Undo([string]$name, [string]$backupId, [string]$project) {
  $link = Find-Link $name
  if (-not $link) { return @{ ok = $false; message = "No such link." } }
  if ($backupId -notmatch '^\d{8}-\d{6}-[a-z0-9][a-z0-9-]{0,39}$' -or -not $backupId.EndsWith("-" + $link.name)) { return @{ ok = $false; message = "bad request" } }
  $grant = Get-Grant $link $project
  if (-not ($grant -and $grant.write)) { return @{ ok = $false; message = "Changes aren't allowed in this folder for this project any more, so BitBull won't write to it, not even to undo. The old files are in $backupRoot\$backupId." } }
  $r = Invoke-BitBullUndo -Root $link.path -BackupDir (Join-Path $backupRoot $backupId)
  if ($r.ok -and $link.mode -eq "filtered") { $r.refreshed = [bool](Do-Refresh $link.name).ok }
  return $r
}

function Do-Link {
  $owner = New-Owner
  try {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "BitBull: choose a folder for the agent to READ (it can't change anything in it). Cancel to link nothing."
    $dlg.ShowNewFolderButton = $false
    if ($dlg.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK -or -not $dlg.SelectedPath) {
      return @{ ok = $false; cancelled = $true; message = "No folder chosen." }
    }
    $path = $dlg.SelectedPath
    $r = Invoke-Link @("-Add", $path)
    $found = ($r.out -split "`n" | Where-Object { $_ -match '^\s{2}\S' } | Select-Object -First 12 | Out-String)
    if ($r.code -eq 4) {
      # BitBull's own repo: only ever as a copy without its secrets
      $q = [System.Windows.Forms.MessageBox]::Show($owner,
        "This is BitBull's own repo. It can be linked as a read-only COPY that leaves out its .env, data folder and anything else that looks secret:`n`n" +
        $found + "`nThe agent never sees those files. The copy is refreshed when you press Refresh in BitBull (Settings > Folders).`n`nLink it this way?",
        "BitBull: link this folder?", "OKCancel", "Information", "Button1")
      if ($q -ne [System.Windows.Forms.DialogResult]::OK) { return @{ ok = $false; cancelled = $true; message = "Not linked." } }
      $r = Invoke-Link @("-Add", $path, "-Hide")
    } elseif ($r.code -eq 3) {
      # keys, wallets or unreadable parts found: you decide, here, in Windows
      $q = [System.Windows.Forms.MessageBox]::Show($owner,
        "This folder holds files that look like keys, passwords or wallets (or couldn't be checked):`n`n" + $found +
        "`nYes (recommended): link a read-only COPY without these files. The agent never sees them; press Refresh in BitBull to update the copy.`n" +
        "No: link the folder as it is, including them. The agent could read them and send them to its model.`n" +
        "Cancel: link nothing.",
        "BitBull: link this folder?", "YesNoCancel", "Warning", "Button1")
      if ($q -eq [System.Windows.Forms.DialogResult]::Yes) { $r = Invoke-Link @("-Add", $path, "-Hide") }
      elseif ($q -eq [System.Windows.Forms.DialogResult]::No) { $r = Invoke-Link @("-Add", $path, "-AllowSecrets") }
      else { return @{ ok = $false; cancelled = $true; message = "Not linked." } }
    }
    if ($r.code -ne 0) { return @{ ok = $false; message = (($r.out -split "`n") | Select-Object -Last 3) -join " " } }
    $name = if ($r.out -match 'BITBULL-LINK-NAME: ([a-z0-9-]+)') { $Matches[1] } else { $null }
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
    $q = [System.Windows.Forms.MessageBox]::Show($owner, "Remove the BitBull link '$name'? BitBull restarts and can no longer read it. Your folder isn't touched.",
      "BitBull: remove link?", "OKCancel", "Question", "Button2")
  } finally { $owner.Close() }
  if ($q -ne [System.Windows.Forms.DialogResult]::OK) { return @{ ok = $false; cancelled = $true; message = "Not removed." } }
  $r = Invoke-Link @("-Remove", $name)
  if ($r.code -ne 0) { return @{ ok = $false; message = (($r.out -split "`n") | Select-Object -Last 2) -join " " } }
  # a removed link takes its permissions with it
  Do-Revoke $name "write" "" | Out-Null
  return @{ ok = $true; message = "Removed $name" }
}

# Open a folder of BitBull's data in Explorer. The page sends the path as the distro sees it
# (/home/<user>/bitbull-data/...); it is validated, mapped to \\wsl.localhost\<distro>\... and must
# exist. Nothing is changed, so no dialog. explorer.exe gets the path as one argument.
function Do-Open([string]$p) {
  if ($p -notmatch '^/home/[a-z_][a-z0-9_-]{0,31}/bitbull-data(/[A-Za-z0-9 _.@+-]+)*/?$' -or $p -match '(^|/)\.\.(/|$)') {
    return @{ ok = $false; message = "That path can't be opened from here (only files and folders under bitbull-data)." }
  }
  $rel = ($p.TrimEnd('/') -replace '/', '\')
  $unc = "\\wsl.localhost\$Distro$rel"
  if (-not (Test-Path -LiteralPath $unc)) { $unc = "\\wsl$\$Distro$rel" }
  if (-not (Test-Path -LiteralPath $unc)) { return @{ ok = $false; message = "Not found or not readable from Windows: $unc. Run start.ps1 once after updating (it makes the data folder readable from this PC)." } }
  # The helper runs hidden, and Windows only lets the foreground process raise a new window:
  # take the foreground with the owner form first, then find the new Explorer window and raise it.
  # a file: open its folder with the file selected
  $isFile = Test-Path -LiteralPath $unc -PathType Leaf
  $owner = New-Owner
  try {
    if ($isFile) { Start-Process explorer.exe -ArgumentList @("/select,`"$unc`"") }
    else { Start-Process explorer.exe -ArgumentList @("`"$unc`"") }
    $shell = New-Object -ComObject Shell.Application
    $folder = if ($isFile) { Split-Path -LiteralPath $unc -Parent } else { $unc }
    $want = ($folder -replace '\\', '/').ToLower()
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 150
      foreach ($w in @($shell.Windows())) {
        try {
          $loc = [string]$w.LocationURL
          if ($loc -and ([uri]::UnescapeDataString($loc) -replace '^file:', '' -replace '\\', '/').ToLower().TrimEnd('/') -eq $want.TrimEnd('/')) {
            [Win32.Native]::ShowWindow([IntPtr]$w.HWND, 9) | Out-Null   # SW_RESTORE
            [Win32.Native]::SetForegroundWindow([IntPtr]$w.HWND) | Out-Null
            return @{ ok = $true; message = "Opened $unc" }
          }
        } catch {}
      }
    }
  } finally { $owner.Close() }
  return @{ ok = $true; message = "Opened $unc (look for the Explorer window on the taskbar)" }
}
Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@


# The vault key: 32 random bytes made once, kept under %LOCALAPPDATA%\BitBull\vault.key protected
# with Windows DPAPI for this user only. BitBull's page fetches it to unlock the vault on the
# server; the server never stores it. Only answered to BitBull's own page (Origin) AND only with
# you present: the Origin header is a browser boundary, not a local one — any process on this PC
# can fake it, so handing the key out needs your OK in a Windows box, like every other action here.
Add-Type -AssemblyName System.Security
$vaultDir = Join-Path $env:LOCALAPPDATA "BitBull"
$vaultKeyFile = Join-Path $vaultDir "vault.key"
# The product was called BitBob until 7 Nov 2026 and the key lived under %LOCALAPPDATA%\BitBob.
# Carry it across BEFORE anything below can decide there is no key: minting a fresh one would
# leave the existing vault permanently undecryptable, every stored key with it. DPAPI ties the
# blob to this Windows user, not to its path, so a copy is all it takes. The old file is left
# where it was, so a rollback to the old build still finds it.
$legacyVaultKey = Join-Path (Join-Path $env:LOCALAPPDATA "BitBob") "vault.key"
if (-not (Test-Path -LiteralPath $vaultKeyFile) -and (Test-Path -LiteralPath $legacyVaultKey)) {
  New-Item -ItemType Directory -Force -Path $vaultDir | Out-Null
  Copy-Item -LiteralPath $legacyVaultKey -Destination $vaultKeyFile
}
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

function Do-VaultKey {
  $owner = New-Owner
  try {
    $q = [System.Windows.Forms.MessageBox]::Show($owner,
      "BitBull wants the vault key to unlock your stored keys.`n`nOnly press OK if you just clicked Unlock in BitBull. This key decrypts every stored key, so nothing else should ever ask for it.",
      "BitBull: unlock the vault?", "OKCancel", "Warning", "Button2")
  } finally { $owner.Close() }
  if ($q -ne [System.Windows.Forms.DialogResult]::OK) { return @{ ok = $false; cancelled = $true; message = "Not unlocked." } }
  return @{ ok = $true; key = (Get-VaultKey) }
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $req = $ctx.Request
    $origin = $req.Headers["Origin"]
    # Only BitBull's own page (or a plain local tool with no Origin, for GET) is answered
    if ($origin -and -not ($origins -contains $origin)) { Send $ctx 403 @{ ok = $false; message = "origin not allowed" }; continue }
    if ($req.HttpMethod -eq "OPTIONS") { Send $ctx 204 @{}; continue }
    $path = $req.Url.AbsolutePath
    if ($req.HttpMethod -eq "GET" -and $path -eq "/status") { Send $ctx 200 @{ ok = $true; links = (Get-Links); caps = @("changes", "undo", "copies", "projects", "expect") }; continue }
    if ($req.HttpMethod -eq "GET" -and $path -eq "/vault-key") {
      if (-not $origin) { Send $ctx 403 @{ ok = $false; message = "BitBull's page only" }; continue }
      Send $ctx 200 (Do-VaultKey); continue
    }
    if ($req.HttpMethod -ne "POST" -or -not $origin) { Send $ctx 405 @{ ok = $false; message = "POST from BitBull's page only" }; continue }
    if ($path -eq "/link") { Send $ctx 200 (Do-Link); continue }
    if ($path -eq "/refresh") {
      $body = (New-Object System.IO.StreamReader($req.InputStream)).ReadToEnd() | ConvertFrom-Json
      Send $ctx 200 (Do-Refresh ([string]$body.name)); continue
    }
    if ($path -eq "/open") {
      $body = (New-Object System.IO.StreamReader($req.InputStream)).ReadToEnd() | ConvertFrom-Json
      Send $ctx 200 (Do-Open ([string]$body.path)); continue
    }
    if ($path -eq "/grant" -or $path -eq "/revoke" -or $path -eq "/apply" -or $path -eq "/undo") {
      $body = (New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)).ReadToEnd() | ConvertFrom-Json
      if ($path -eq "/grant") { Send $ctx 200 (Do-Grant ([string]$body.name) ([string]$body.what) ([string]$body.project) ([string]$body.projectName)); continue }
      if ($path -eq "/revoke") { Send $ctx 200 (Do-Revoke ([string]$body.name) ([string]$body.what) ([string]$body.project)); continue }
      if ($path -eq "/undo") { Send $ctx 200 (Do-Undo ([string]$body.name) ([string]$body.backup) ([string]$body.project)); continue }
      Send $ctx 200 (Do-Apply $body); continue
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
