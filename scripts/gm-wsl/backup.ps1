<#
  Back up everything GM keeps (chats, projects, uploads, settings) to one file on Windows.
  Hippius only mirrors uploads; this is the copy of agent.db and the rest.

      powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\backup.ps1
      ... -To "E:\Backups\GM"          a different folder (default: Documents\GM backups)
      ... -Keep 10                     keep the newest 10 backups there, delete older ones

  The file holds settings.local.json, so any keys you entered in the UI are in it: keep it
  somewhere private. GM keeps running; a turn that writes while the backup runs may be caught
  half-way in that one file, so back up when GM is idle.

  Restore (GM stopped):
      wsl -d gm -u root --exec sh -c "rm -rf /home/<you>/gm-data.old; mv /home/<you>/gm-data /home/<you>/gm-data.old"
      type "<backup>.tgz" | wsl -d gm -u root --exec tar -xzf - -C /home/<you>
#>
param(
  [string]$To = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "GM backups"),
  [int]$Keep = 0,
  [string]$Distro = "gm"
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"

$userHome = (& wsl.exe -d $Distro --exec sh -c 'printf %s "$HOME"')
if ($userHome -notmatch '^/[A-Za-z0-9/_.-]+$') { throw "unexpected home folder in the $Distro distro: $userHome" }
if ($To -cnotmatch '^[A-Za-z]:\\[A-Za-z0-9 _.,()+\-\\]*$') { throw "Use a plain local folder for -To (letters, digits, space and _ . , ( ) + - only)." }
New-Item -ItemType Directory -Force -Path $To | Out-Null
$file = Join-Path $To ("gm-data-{0}.tgz" -f (Get-Date -Format "yyyy-MM-dd-HHmm"))

Write-Host "==> Backing up $userHome/gm-data to $file" -ForegroundColor Cyan
# cmd's redirection keeps the stream binary-safe (Windows PowerShell's doesn't). Caches and
# engine sandboxes are left out: they are rebuilt on start.
$cmdFile = Join-Path $env:TEMP "gm-backup.cmd"
Set-Content -LiteralPath $cmdFile -Encoding ASCII -Value "@wsl.exe -d $Distro -u root --exec tar -czf - -C $userHome --exclude=gm-data/cache --exclude=gm-data/tmp --exclude=gm-data/opencode-sandbox/cache gm-data > `"$file`""
& cmd.exe /c $cmdFile
if ($LASTEXITCODE -ne 0) { Remove-Item -Force -ErrorAction SilentlyContinue $file; throw "backup failed ($LASTEXITCODE)" }

$size = (Get-Item $file).Length
if ($size -lt 1024) { throw "The backup is suspiciously small ($size bytes). Check that GM's data is at $userHome/gm-data." }
Write-Host ("Backed up: {0} ({1:N1} MB)" -f $file, ($size / 1MB)) -ForegroundColor Green
Write-Host "It contains any keys saved in the UI: keep it private." -ForegroundColor DarkGray

if ($Keep -gt 0) {
  Get-ChildItem -LiteralPath $To -Filter "gm-data-*.tgz" | Sort-Object Name -Descending | Select-Object -Skip $Keep |
    ForEach-Object { Remove-Item -Force $_.FullName; Write-Host "Removed old backup $($_.Name)" -ForegroundColor DarkGray }
}
