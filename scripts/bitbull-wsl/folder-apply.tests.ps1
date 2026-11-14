<#
  Tests for folder-apply.ps1. Run with PowerShell 7 on any OS, or Windows PowerShell 5.1:

      pwsh -NoProfile -File scripts/bitbull-wsl/folder-apply.tests.ps1

  Exits 1 if anything fails. Needs git for the branch tests (skipped without it).
#>
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "folder-apply.ps1")

$script:failed = 0; $script:passed = 0
function Check([string]$name, [bool]$cond) {
  if ($cond) { $script:passed++ } else { $script:failed++; Write-Host "FAIL: $name" -ForegroundColor Red }
}
function New-Tmp { $d = Join-Path ([System.IO.Path]::GetTempPath()) ("bb-apply-" + [guid]::NewGuid().ToString("N")); New-Item -ItemType Directory -Path $d | Out-Null; return $d }
function Put([string]$root, [string]$rel, [string]$text) {
  $p = Join-BitBullPath $root $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
  [System.IO.File]::WriteAllText($p, $text)
  return $p
}
function Entry([string]$staging, [string]$rel, [string]$text) {
  $p = Put $staging $rel $text
  return @{ path = $rel; sha256 = (Get-BitBullSha256 $p) }
}

# ---------- what may never be written ----------
$bad = @(".git/hooks/pre-commit", ".git/config", "sub/.git/hooks/x", ".GIT/config", "GIT~1/config", "a/.vscode/tasks.json", ".idea/x.xml",
  ".github/workflows/ci.yml", ".GitHub/Workflows/ci.yml", ".husky/pre-commit", ".githooks/x", ".devcontainer/devcontainer.json",
  ".env", "app/.env.production", ".ENV", ".bashrc", "home/.zshrc", ".gitconfig", ".envrc", "tool.exe", "x/y.DLL", "run.lnk", "a.url",
  "../outside.txt", "a/../../b", "/etc/passwd", "C:/Windows/x", "a\b.txt", "a//b", "file.txt:stream", "name.", "name ", "CON", "nul.txt", "a/COM1",
  "a<b.txt", "", "desktop.ini")
foreach ($b in $bad) { Check "refuses '$b'" ($null -ne (Test-BitBullRelPath $b)) }
$good = @("README.md", "src/app.ts", ".env.example", ".github/ISSUE_TEMPLATE/bug.md", ".gitignore", ".gitattributes", "scripts/deploy.ps1", "a/b/c/d.json", "docs/git/notes.md", "environment.ts", "x.env.md", "my.gitconfig.txt")
foreach ($g in $good) { Check "allows '$g'" ($null -eq (Test-BitBullRelPath $g)) }

# ---------- files mode ----------
$root = New-Tmp; $stage = New-Tmp; $backup = New-Tmp
Put $root "README.md" "old readme" | Out-Null
Put $root "src/keep.ts" "keep" | Out-Null
Put $root "src/gone.ts" "to delete" | Out-Null
$m = @((Entry $stage "README.md" "new readme"), (Entry $stage "src/new/deep.ts" "export const x = 1"))
$r = Invoke-BitBullApply -Root $root -Staging $stage -Manifest $m -Deletes @() -AllowDelete $false -BackupDir $backup
Check "applies" ($r.ok -and $r.written -eq 2)
Check "overwrote" ((Get-Content -Raw (Join-BitBullPath $root "README.md")) -eq "new readme")
Check "created nested" ((Get-Content -Raw (Join-BitBullPath $root "src/new/deep.ts")) -eq "export const x = 1")
Check "backed up what it replaced" ((Get-Content -Raw (Join-BitBullPath $backup "README.md")) -eq "old readme")
Check "left the rest" ((Get-Content -Raw (Join-BitBullPath $root "src/keep.ts")) -eq "keep")

# deleting needs its own permission
$r = Invoke-BitBullApply -Root $root -Staging $stage -Manifest @() -Deletes @("src/gone.ts") -AllowDelete $false -BackupDir $backup
Check "no delete without permission" (-not $r.ok -and (Test-Path (Join-BitBullPath $root "src/gone.ts")))
$r = Invoke-BitBullApply -Root $root -Staging $stage -Manifest @() -Deletes @("src/gone.ts", "src/never-was.ts") -AllowDelete $true -BackupDir $backup
Check "deletes with permission" ($r.ok -and $r.deleted -eq 1 -and -not (Test-Path (Join-BitBullPath $root "src/gone.ts")))
Check "deleted file was backed up" ((Get-Content -Raw (Join-BitBullPath $backup "src/gone.ts")) -eq "to delete")

# a staged file that changed after it was shown: nothing at all is written
$m = @((Entry $stage "a.txt" "A"), (Entry $stage "b.txt" "B"))
[System.IO.File]::WriteAllText((Join-BitBullPath $stage "b.txt"), "swapped")
$r = Invoke-BitBullApply -Root $root -Staging $stage -Manifest $m -Deletes @() -AllowDelete $false -BackupDir $backup
Check "tampered staging refused" (-not $r.ok -and $r.message -match "changed after")
Check "and nothing written, not even the good file" (-not (Test-Path (Join-BitBullPath $root "a.txt")))

# one protected path refuses the whole set
$m = @((Entry $stage "ok.txt" "fine"), (Entry $stage ".git/hooks/pre-commit" "#!/bin/sh"))
$r = Invoke-BitBullApply -Root $root -Staging $stage -Manifest $m -Deletes @() -AllowDelete $false -BackupDir $backup
Check "protected path refuses the set" (-not $r.ok -and -not (Test-Path (Join-BitBullPath $root "ok.txt")) -and -not (Test-Path (Join-BitBullPath $root ".git/hooks/pre-commit")))
$r = Invoke-BitBullApply -Root $root -Staging $stage -Manifest @() -Deletes @(".git/config") -AllowDelete $true -BackupDir $backup
Check "protected path can't be deleted either" (-not $r.ok)

# a link inside the folder can't carry a write out of it
$outside = New-Tmp
try {
  New-Item -ItemType SymbolicLink -Path (Join-BitBullPath $root "escape") -Target $outside -ErrorAction Stop | Out-Null
  $m = @((Entry $stage "escape/planted.txt" "x"))
  $r = Invoke-BitBullApply -Root $root -Staging $stage -Manifest $m -Deletes @() -AllowDelete $false -BackupDir $backup
  Check "won't write through a link" (-not $r.ok -and -not (Test-Path (Join-BitBullPath $outside "planted.txt")))
} catch { Write-Host "skipped: symbolic links can't be made here ($($_.Exception.Message))" -ForegroundColor Yellow }

# a folder where a file should be, and the reverse
Put $root "isfile" "x" | Out-Null
$r = Invoke-BitBullApply -Root $root -Staging $stage -Manifest @((Entry $stage "isfile/child.txt" "x")) -Deletes @() -AllowDelete $false -BackupDir $backup
Check "file in the way of a folder" (-not $r.ok)
$stage3 = New-Tmp
$r = Invoke-BitBullApply -Root $root -Staging $stage3 -Manifest @((Entry $stage3 "src" "x")) -Deletes @() -AllowDelete $false -BackupDir $backup
Check "folder in the way of a file" (-not $r.ok)
$r = Invoke-BitBullApply -Root (Join-Path $root "nope") -Staging $stage -Manifest @((Entry $stage "z.txt" "z")) -Deletes @() -AllowDelete $false -BackupDir $backup
Check "missing folder" (-not $r.ok)
$r = Invoke-BitBullApply -Root $root -Staging $stage -Manifest @() -Deletes @() -AllowDelete $false -BackupDir $backup
Check "empty set" (-not $r.ok)

# ---------- branch mode ----------
if (Get-Command git -ErrorAction SilentlyContinue) {
  $proj = New-Tmp; $repo = Join-BitBullPath $proj "myrepo"; $st2 = New-Tmp
  New-Item -ItemType Directory -Path $repo | Out-Null
  & git -C $repo init -q -b main 2>&1 | Out-Null
  Put $repo "README.md" "v1" | Out-Null
  Put $repo "old.txt" "old" | Out-Null
  & git -C $repo add -A 2>&1 | Out-Null
  & git -C $repo -c user.name=t -c user.email=t@t commit -q -m first 2>&1 | Out-Null
  # your own unfinished work, which must survive untouched
  [System.IO.File]::WriteAllText((Join-BitBullPath $repo "README.md"), "my uncommitted edit")
  # a hook that would give the game away if anything ran it
  Put $repo ".git/hooks/reference-transaction" "#!/bin/sh`ntouch `"$proj/HOOK-RAN`"`n" | Out-Null
  if (-not $IsWindows) { & chmod +x (Join-BitBullPath $repo ".git/hooks/reference-transaction") }
  $before = (& git -C $repo status --porcelain | Out-String)
  $m = @((Entry $st2 "myrepo/README.md" "v2 from BitBull"), (Entry $st2 "myrepo/src/new.ts" "export {}"))
  $r = Invoke-BitBullBranch -Root $proj -Staging $st2 -Manifest $m -Deletes @("myrepo/old.txt") -Branch "bitbull/readme-fix-ab12" -Message "Update the readme"
  Check "branch made" ($r.ok -and $r.branch -eq "bitbull/readme-fix-ab12")
  Check "working file untouched" ((Get-Content -Raw (Join-BitBullPath $repo "README.md")) -eq "my uncommitted edit")
  Check "status unchanged" ((& git -C $repo status --porcelain | Out-String) -eq $before)
  Check "still on main" ((& git -C $repo rev-parse --abbrev-ref HEAD) -eq "main")
  Check "branch has the new readme" ((& git -C $repo show "bitbull/readme-fix-ab12:README.md") -eq "v2 from BitBull")
  Check "branch has the new file" ((& git -C $repo show "bitbull/readme-fix-ab12:src/new.ts") -eq "export {}")
  & git -C $repo cat-file -e "bitbull/readme-fix-ab12:old.txt" 2>$null
  Check "branch dropped the deleted file" ($LASTEXITCODE -ne 0)
  Check "one commit on top of main" ((& git -C $repo rev-parse "bitbull/readme-fix-ab12~1") -eq (& git -C $repo rev-parse main))
  Check "no hook ran" (-not (Test-Path (Join-BitBullPath $proj "HOOK-RAN")))
  $r2 = Invoke-BitBullBranch -Root $proj -Staging $st2 -Manifest $m -Deletes @() -Branch "bitbull/readme-fix-ab12" -Message "again"
  Check "existing branch is never moved" (-not $r2.ok -and $r2.message -match "already exists")
  $r3 = Invoke-BitBullBranch -Root $proj -Staging $st2 -Manifest $m -Deletes @() -Branch "main" -Message "x"
  Check "only bitbull/ branches" (-not $r3.ok)
  $r4 = Invoke-BitBullBranch -Root $proj -Staging $st2 -Manifest @((Entry $st2 "loose.txt" "x")) -Deletes @() -Branch "bitbull/loose" -Message "x"
  Check "no repo, no branch" (-not $r4.ok -and $r4.message -match "not all inside one git repo")
  $r5 = Invoke-BitBullBranch -Root $proj -Staging $st2 -Manifest @((Entry $st2 "myrepo/.github/workflows/ci.yml" "x")) -Deletes @() -Branch "bitbull/ci" -Message "x"
  Check "protected paths are refused on a branch too" (-not $r5.ok)
  Check "repo found for nested paths" ((Find-BitBullRepo $proj @("myrepo/a/b/c.txt", "myrepo/x.txt")) -eq "myrepo")
  Check "no repo across two" ($null -eq (Find-BitBullRepo $proj @("myrepo/a.txt", "other/b.txt")))
} else { Write-Host "skipped: git is not installed, branch tests not run" -ForegroundColor Yellow }

# ---------- grants ----------
$gf = Join-Path (New-Tmp) "sub/folder-access.json"
Check "no file, no grants" ((Get-BitBullGrants $gf).Count -eq 0)
$g = @{ github = @{ write = $true; delete = $false; path = "D:\github"; since = "2026-11-14" } }
Save-BitBullGrants $gf $g
$back = Get-BitBullGrants $gf
Check "grants round-trip" ($back.github.write -eq $true -and $back.github.delete -eq $false -and $back.github.path -eq "D:\github")
[System.IO.File]::WriteAllText($gf, "{not json")
Check "damaged file means no grants" ((Get-BitBullGrants $gf).Count -eq 0)

Write-Host "$script:passed passed, $script:failed failed"
if ($script:failed) { exit 1 }
