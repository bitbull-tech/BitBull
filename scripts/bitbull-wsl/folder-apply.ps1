<#
  Changes to a linked folder, applied on this PC, never by the agent.

  The agent only ever sees a linked folder read-only. When it wants to change files there it
  proposes a change set; BitBull stages the new files in its own data folder and shows you the
  list and the diff. Only when you approve does the link helper (link-helper.ps1, which
  dot-sources this file) copy them into your folder, with the rules below. Nothing in the
  sandbox can reach this code: it runs on Windows, as you.

  Two ways to apply a change set:
    files   copy the new files into the folder (and, if you allowed deleting, send the removed
            ones to the Recycle Bin). What was overwritten is kept in a backup folder first.
    branch  when the files are inside a git repo: leave your working files alone and put the
            change on a new branch bitbull/<name>, made from the repo's current commit. You
            review and merge it with your own tools. This is the safer one.

  What is never written, whatever was approved (Test-BitBullRelPath): anything that would run
  on this PC without you choosing to run it, or that is a secret.
    - .git (hooks, config, everything in it), .gitconfig, .githooks, .husky
    - editor and CI files that run things: .vscode, .idea, .devcontainer, .github/workflows
    - shell start-up files and .envrc; .env and .env.* (templates like .env.example are fine)
    - programs and shortcuts: .exe .dll .msi .scr .com .pif .lnk .url
    - names Windows could read as something else: 8.3 short names (GIT~1), a colon (alternate
      data streams), trailing dots or spaces, device names (CON, NUL, ...), ".." and absolute paths
  And nothing is written through a junction or symbolic link, so a change can't leave the folder.

  Written for Windows PowerShell 5.1 (what the helper runs under); the tests run it under
  PowerShell 7 on any OS (scripts/bitbull-wsl/folder-apply.tests.ps1).
#>

$script:BitBullProtectedDirs = @(".git", ".githooks", ".husky", ".vscode", ".idea", ".devcontainer")
$script:BitBullProtectedFiles = @(".gitconfig", ".envrc", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", "desktop.ini", "autorun.inf")
$script:BitBullProtectedExt = @(".exe", ".dll", ".msi", ".scr", ".com", ".pif", ".lnk", ".url", ".sys", ".cpl")
$script:BitBullEnvTemplates = @(".env.example", ".env.sample", ".env.template", ".env.dist")
$script:BitBullDevices = @("con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9")

# $null when the path may be written; otherwise the reason it may not. $rel uses forward slashes.
function Test-BitBullRelPath([string]$rel) {
  if (-not $rel) { return "empty path" }
  if ($rel.Length -gt 400) { return "path too long" }
  if ($rel -match '[\x00-\x1f]') { return "control character in the path" }
  if ($rel.Contains("\") -or $rel.StartsWith("/") -or $rel -match '^[A-Za-z]:') { return "not a path inside the folder" }
  $parts = $rel.Split("/")
  for ($i = 0; $i -lt $parts.Length; $i++) {
    $p = $parts[$i]
    $low = $p.ToLowerInvariant()
    if ($p -eq "" -or $p -eq "." -or $p -eq "..") { return "not a path inside the folder" }
    if ($p.Contains(":")) { return "a colon in a name (alternate data stream)" }
    if ($p -match '[<>"|?*]') { return "a character Windows does not allow in names" }
    if ($p.EndsWith(".") -or $p.EndsWith(" ")) { return "a name ending in a dot or a space" }
    if ($p -match '~\d') { return "a short (8.3) name, which could stand for a protected folder" }
    $stem = $low.Split(".")[0]
    if ($script:BitBullDevices -contains $stem) { return "a Windows device name" }
    if ($script:BitBullProtectedDirs -contains $low) { return "$p is protected (it can run things on this PC)" }
    if ($low -eq ".github" -and ($i + 1) -lt $parts.Length -and $parts[$i + 1].ToLowerInvariant() -eq "workflows") { return ".github/workflows is protected (CI runs it)" }
  }
  $name = $parts[$parts.Length - 1].ToLowerInvariant()
  if ($script:BitBullProtectedFiles -contains $name) { return "$name is protected (it runs when a shell or Explorer opens)" }
  if (($name -eq ".env" -or $name.StartsWith(".env.")) -and -not ($script:BitBullEnvTemplates -contains $name)) { return "$name is protected (it holds secrets)" }
  $dot = $name.LastIndexOf(".")
  if ($dot -ge 0 -and ($script:BitBullProtectedExt -contains $name.Substring($dot))) { return "programs and shortcuts are not written" }
  return $null
}

function Join-BitBullPath([string]$root, [string]$rel) {
  $p = $root
  foreach ($part in $rel.Split("/")) { $p = [System.IO.Path]::Combine($p, $part) }
  return $p
}

# Every folder from the root down to the file's parent that already exists must be a real folder:
# a junction or symbolic link there would send the write somewhere else.
function Test-BitBullNoLinks([string]$root, [string]$rel) {
  $p = $root
  $parts = $rel.Split("/")
  for ($i = 0; $i -lt $parts.Length; $i++) {
    $p = [System.IO.Path]::Combine($p, $parts[$i])
    $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return "$($parts[$i]) is a link to somewhere else" }
    if ($i -lt ($parts.Length - 1) -and -not $item.PSIsContainer) { return "$($parts[$i]) is a file, not a folder" }
    if ($i -eq ($parts.Length - 1) -and $item.PSIsContainer) { return "$($parts[$i]) is a folder, not a file" }
  }
  return $null
}

function Get-BitBullSha256([string]$file) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
}

# Checks everything before anything is written. Returns @{ ok; message; files = @(@{ rel; src; dest }) ; deletes = @(@{ rel; dest }) }
function Test-BitBullChangeSet {
  param([string]$Root, [string]$Staging, $Manifest, $Deletes, [bool]$AllowDelete)
  $files = @(); $dels = @()
  $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue
  if (-not $rootItem -or -not $rootItem.PSIsContainer) { return @{ ok = $false; message = "The folder is not there: $Root" } }
  if (-not (Test-Path -LiteralPath $Staging -PathType Container)) { return @{ ok = $false; message = "The staged files are not readable from here: $Staging" } }
  $list = @($Manifest)
  $dlist = @($Deletes)
  if (($list.Count + $dlist.Count) -eq 0) { return @{ ok = $false; message = "Nothing to apply." } }
  if (($list.Count + $dlist.Count) -gt 500) { return @{ ok = $false; message = "Too many files in one change (500 at most)." } }
  $seen = @{}
  foreach ($m in $list) {
    $rel = [string]$m.path
    $why = Test-BitBullRelPath $rel
    if ($why) { return @{ ok = $false; message = "Refused ${rel}: $why" } }
    $key = $rel.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { return @{ ok = $false; message = "Refused ${rel}: listed twice" } }
    $seen[$key] = $true
    $why = Test-BitBullNoLinks $Root $rel
    if ($why) { return @{ ok = $false; message = "Refused ${rel}: $why" } }
    $src = Join-BitBullPath $Staging $rel
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { return @{ ok = $false; message = "The staged copy of $rel is missing." } }
    # what you approved is the content with this hash: anything else is not what you saw
    if ((Get-BitBullSha256 $src) -ne ([string]$m.sha256).ToLowerInvariant()) { return @{ ok = $false; message = "The staged copy of $rel changed after you were shown it. Nothing was written." } }
    $files += @{ rel = $rel; src = $src; dest = (Join-BitBullPath $Root $rel) }
  }
  foreach ($d in $dlist) {
    $rel = [string]$d
    if (-not $AllowDelete) { return @{ ok = $false; message = "This change deletes files, and deleting is not allowed in this folder. Allow it in Settings, Folders first." } }
    $why = Test-BitBullRelPath $rel
    if ($why) { return @{ ok = $false; message = "Refused deleting ${rel}: $why" } }
    if ($seen.ContainsKey($rel.ToLowerInvariant())) { return @{ ok = $false; message = "Refused ${rel}: both written and deleted" } }
    $why = Test-BitBullNoLinks $Root $rel
    if ($why) { return @{ ok = $false; message = "Refused deleting ${rel}: $why" } }
    $dels += @{ rel = $rel; dest = (Join-BitBullPath $Root $rel) }
  }
  return @{ ok = $true; files = $files; deletes = $dels }
}

function Remove-BitBullToBin([string]$file) {
  # the Recycle Bin on Windows, so a delete can be undone; elsewhere (tests) a plain delete
  $done = $false
  try {
    Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction Stop
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($file, "OnlyErrorDialogs", "SendToRecycleBin")
    $done = $true
  } catch { $done = $false }
  if (-not $done) { Remove-Item -LiteralPath $file -Force }
}

# files mode: copy into the folder. Overwritten and deleted files are copied to $BackupDir first.
function Invoke-BitBullApply {
  param([string]$Root, [string]$Staging, $Manifest, $Deletes, [bool]$AllowDelete, [string]$BackupDir)
  $check = Test-BitBullChangeSet -Root $Root -Staging $Staging -Manifest $Manifest -Deletes $Deletes -AllowDelete $AllowDelete
  if (-not $check.ok) { return $check }
  $written = 0; $deleted = 0; $backedUp = 0
  try {
    foreach ($f in $check.files) {
      if ($BackupDir -and (Test-Path -LiteralPath $f.dest -PathType Leaf)) {
        $b = Join-BitBullPath $BackupDir $f.rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $b) | Out-Null
        [System.IO.File]::Copy($f.dest, $b, $true); $backedUp++
      }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $f.dest) | Out-Null
      [System.IO.File]::Copy($f.src, $f.dest, $true)
      $written++
    }
    foreach ($d in $check.deletes) {
      if (-not (Test-Path -LiteralPath $d.dest -PathType Leaf)) { continue }
      if ($BackupDir) {
        $b = Join-BitBullPath $BackupDir $d.rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $b) | Out-Null
        [System.IO.File]::Copy($d.dest, $b, $true); $backedUp++
      }
      Remove-BitBullToBin $d.dest
      $deleted++
    }
  } catch {
    return @{ ok = $false; message = "Stopped after $written written, $deleted deleted: $($_.Exception.Message)"; written = $written; deleted = $deleted; backup = $BackupDir }
  }
  return @{ ok = $true; written = $written; deleted = $deleted; backedUp = $backedUp; backup = $BackupDir; message = "Wrote $written file(s)" + $(if ($deleted) { ", deleted $deleted" } else { "" }) }
}

function Invoke-BitBullGit([string]$repo, [string[]]$argv) {
  # no pager, no prompts, and never the repo's own hooks
  $out = & git -C $repo -c core.hooksPath=/dev/null -c core.fsmonitor=false @argv 2>&1 | Out-String
  return @{ code = $LASTEXITCODE; out = $out.Trim() }
}

# The git repo the whole change sits in: the nearest folder with .git at or above every path,
# inside $Root. $null when there is none, or the paths span more than one.
function Find-BitBullRepo([string]$Root, [string[]]$rels) {
  $found = $null
  foreach ($rel in $rels) {
    $parts = $rel.Split("/")
    $hit = $null
    for ($n = $parts.Length - 1; $n -ge 0; $n--) {
      $sub = ($parts[0..($n - 1)] -join "/")
      if ($n -eq 0) { $sub = "" }
      $dir = $Root
      if ($sub) { $dir = Join-BitBullPath $Root $sub }
      if (Test-Path -LiteralPath ([System.IO.Path]::Combine($dir, ".git"))) { $hit = $sub; break }
    }
    if ($null -eq $hit) { return $null }
    if ($null -eq $found) { $found = $hit } elseif ($found -ne $hit) { return $null }
  }
  return $found
}

# branch mode: a new branch from the repo's current commit holding the change. The working files,
# the index and the checked-out branch are not touched: the commit is built with a private index.
function Invoke-BitBullBranch {
  param([string]$Root, [string]$Staging, $Manifest, $Deletes, [string]$Branch, [string]$Message)
  $check = Test-BitBullChangeSet -Root $Root -Staging $Staging -Manifest $Manifest -Deletes $Deletes -AllowDelete $true
  if (-not $check.ok) { return $check }
  if ($Branch -notmatch '^bitbull/[a-z0-9][a-z0-9._-]{0,60}$' -or $Branch.Contains("..") -or $Branch.EndsWith(".lock") -or $Branch.EndsWith(".")) { return @{ ok = $false; message = "Not a branch name BitBull makes: $Branch" } }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return @{ ok = $false; message = "git is not installed on this PC (or not on PATH), so a branch can't be made. Apply the files instead, or install Git for Windows." } }
  $rels = @($check.files | ForEach-Object { $_.rel }) + @($check.deletes | ForEach-Object { $_.rel })
  $sub = Find-BitBullRepo $Root $rels
  if ($null -eq $sub) { return @{ ok = $false; message = "These files are not all inside one git repo in this folder, so there is no branch to put them on." } }
  $repo = $Root
  if ($sub) { $repo = Join-BitBullPath $Root $sub }
  $strip = 0
  if ($sub) { $strip = $sub.Length + 1 }

  $head = Invoke-BitBullGit $repo @("rev-parse", "--verify", "--quiet", "HEAD^{commit}")
  if ($head.code -ne 0) { return @{ ok = $false; message = "The repo has no commit yet, so there is nothing to branch from." } }
  $exists = Invoke-BitBullGit $repo @("rev-parse", "--verify", "--quiet", "refs/heads/$Branch")
  if ($exists.code -eq 0) { return @{ ok = $false; message = "The branch $Branch already exists in that repo." } }

  $index = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "bitbull-index-" + [guid]::NewGuid().ToString("N"))
  $old = $env:GIT_INDEX_FILE
  $env:GIT_INDEX_FILE = $index
  try {
    $r = Invoke-BitBullGit $repo @("read-tree", $head.out)
    if ($r.code -ne 0) { return @{ ok = $false; message = "git read-tree failed: $($r.out)" } }
    foreach ($f in $check.files) {
      $inRepo = $f.rel.Substring($strip)
      $blob = Invoke-BitBullGit $repo @("hash-object", "-w", "--path", $inRepo, "--", $f.src)
      if ($blob.code -ne 0 -or $blob.out -notmatch '^[0-9a-f]{40,64}$') { return @{ ok = $false; message = "git could not store ${inRepo}: $($blob.out)" } }
      # keep the file's mode if it is already in the repo (an executable script stays one)
      $mode = "100644"
      $ls = Invoke-BitBullGit $repo @("ls-tree", $head.out, "--", $inRepo)
      if ($ls.code -eq 0 -and $ls.out -match '^(100644|100755) blob ') { $mode = $Matches[1] }
      $r = Invoke-BitBullGit $repo @("update-index", "--add", "--cacheinfo", "$mode,$($blob.out),$inRepo")
      if ($r.code -ne 0) { return @{ ok = $false; message = "git could not add ${inRepo}: $($r.out)" } }
    }
    foreach ($d in $check.deletes) {
      $r = Invoke-BitBullGit $repo @("update-index", "--force-remove", "--", $d.rel.Substring($strip))
      if ($r.code -ne 0) { return @{ ok = $false; message = "git could not remove $($d.rel): $($r.out)" } }
    }
    $tree = Invoke-BitBullGit $repo @("write-tree")
    if ($tree.code -ne 0) { return @{ ok = $false; message = "git write-tree failed: $($tree.out)" } }
    $headTree = Invoke-BitBullGit $repo @("rev-parse", "$($head.out)^{tree}")
    if ($headTree.out -eq $tree.out) { return @{ ok = $false; message = "The repo's current commit already has exactly these contents: nothing to put on a branch." } }
    $msg = $Message
    if (-not $msg) { $msg = "Changes from BitBull" }
    $commit = Invoke-BitBullGit $repo @("-c", "user.name=BitBull", "-c", "user.email=bitbull@localhost", "commit-tree", $tree.out, "-p", $head.out, "-m", $msg)
    if ($commit.code -ne 0 -or $commit.out -notmatch '^[0-9a-f]{40,64}$') { return @{ ok = $false; message = "git commit-tree failed: $($commit.out)" } }
    # the old value is all zeros: the ref is only created, never moved
    $r = Invoke-BitBullGit $repo @("update-ref", "refs/heads/$Branch", $commit.out, ("0" * $commit.out.Length))
    if ($r.code -ne 0) { return @{ ok = $false; message = "git could not create the branch: $($r.out)" } }
    return @{ ok = $true; branch = $Branch; repo = $repo; commit = $commit.out; written = $check.files.Count; deleted = $check.deletes.Count; message = "Branch $Branch created in $repo. Your working files were not touched." }
  } finally {
    $env:GIT_INDEX_FILE = $old
    Remove-Item -LiteralPath $index -Force -ErrorAction SilentlyContinue
  }
}

# ---------- who may be changed: kept on this PC, outside anything BitBull can write ----------

function Get-BitBullGrants([string]$file) {
  $g = @{}
  if (Test-Path -LiteralPath $file) {
    try {
      $j = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
      foreach ($p in $j.PSObject.Properties) {
        $g[$p.Name] = @{ write = [bool]$p.Value.write; delete = [bool]$p.Value.delete; path = [string]$p.Value.path; since = [string]$p.Value.since }
      }
    } catch { $g = @{} }
  }
  return $g
}

function Save-BitBullGrants([string]$file, $grants) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
  ($grants | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $file -Encoding UTF8
}
