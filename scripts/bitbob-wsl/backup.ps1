<#
  Back up everything BitBob keeps (chats, projects, uploads, settings) to one file on Windows.
  Hippius only mirrors uploads; this is the copy of agent.db and the rest.

      powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\backup.ps1
      ... -To "E:\Backups\BitBob"          a different folder (default: Documents\BitBob backups)
      ... -Keep 10                     keep the newest 10 backups there, delete older ones

  The file holds settings.local.json, so any keys you entered in the UI are in it: keep it
  somewhere private. BitBob keeps running; a turn that writes while the backup runs may be caught
  half-way in that one file, so back up when BitBob is idle.

  Restore (BitBob stopped):
      wsl -d bitbob -u root --exec sh -c "rm -rf /home/<you>/bitbob-data.old; mv /home/<you>/bitbob-data /home/<you>/bitbob-data.old"
      type "<backup>.tgz" | wsl -d bitbob -u root --exec tar -xzf - -C /home/<you>
#>
param(
  [string]$To = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "BitBob backups"),
  [int]$Keep = 0,
  [string]$Distro = "bitbob"
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1"

$userHome = (& wsl.exe -d $Distro --exec sh -c 'printf %s "$HOME"')
if ($userHome -notmatch '^/[A-Za-z0-9/_.-]+$') { throw "unexpected home folder in the $Distro distro: $userHome" }
if ($To -cnotmatch '^[A-Za-z]:\\[A-Za-z0-9 _.,()+\-\\]*$') { throw "Use a plain local folder for -To (letters, digits, space and _ . , ( ) + - only)." }
New-Item -ItemType Directory -Force -Path $To | Out-Null
$file = Join-Path $To ("bitbob-data-{0}.tgz" -f (Get-Date -Format "yyyy-MM-dd-HHmm"))

Write-Host "==> Backing up $userHome/bitbob-data to $file" -ForegroundColor Cyan
# cmd's redirection keeps the stream binary-safe (Windows PowerShell's doesn't). Caches and
# engine sandboxes are left out: they are rebuilt on start.
$cmdFile = Join-Path $env:TEMP "bitbob-backup.cmd"
Set-Content -LiteralPath $cmdFile -Encoding ASCII -Value "@wsl.exe -d $Distro -u root --exec tar -czf - -C $userHome --exclude=bitbob-data/cache --exclude=bitbob-data/tmp --exclude=bitbob-data/opencode-sandbox/cache bitbob-data > `"$file`""
& cmd.exe /c $cmdFile
if ($LASTEXITCODE -ne 0) { Remove-Item -Force -ErrorAction SilentlyContinue $file; throw "backup failed ($LASTEXITCODE)" }

$size = (Get-Item $file).Length
if ($size -lt 1024) { throw "The backup is suspiciously small ($size bytes). Check that BitBob's data is at $userHome/bitbob-data." }
Write-Host ("Backed up: {0} ({1:N1} MB)" -f $file, ($size / 1MB)) -ForegroundColor Green
Write-Host "It contains any keys saved in the UI: keep it private." -ForegroundColor DarkGray

if ($Keep -gt 0) {
  Get-ChildItem -LiteralPath $To -Filter "bitbob-data-*.tgz" | Sort-Object Name -Descending | Select-Object -Skip $Keep |
    ForEach-Object { Remove-Item -Force $_.FullName; Write-Host "Removed old backup $($_.Name)" -ForegroundColor DarkGray }
}
