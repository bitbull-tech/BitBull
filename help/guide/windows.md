## Before you start

- Windows 10 (version 2004 or later) or Windows 11, on an Intel or AMD PC
- About 10 GB of free disk space
- Your three keys ([see Getting started](/guide/getting-started#before-you-start-three-keys))

### What is WSL, and why does BitBull need it?

**WSL** (Windows Subsystem for Linux) is a free part of Windows, made by Microsoft, that lets your
PC run Linux programs. BitBull uses it to create its own small, private Linux computer called
`bitbull`, inside your PC. That private computer:

- **can't see your drives or files**, unless you choose to link a folder (read-only)
- **can't start Windows programs**
- **runs BitBull's containers** for you, so you don't need Docker Desktop or anything else

You install WSL once. After that, BitBull takes care of it.

## Option 1: let your AI agent do it (easiest)

If you use an AI coding agent on this PC, paste this into it:

```text
Set up BitBull for me. Fetch https://www.bitbull.tech/get-started.md and follow it.
```

It will ask before installing anything, and tell you when BitBull is ready.

## Option 2: step by step

Each step is a command to copy and paste. Where a step says **PowerShell**, open it from the Start
menu (type *PowerShell*).

> **How to paste a command:** click the copy button on the grey box (or select the text and press
> Ctrl+C), click inside the PowerShell window, press **Ctrl+V** (or right-click), then press
> **Enter**. Wait until it finishes and you see the blinking cursor again before pasting the next
> one.

**1. Turn on WSL** (once). Open PowerShell **as administrator** (right-click → *Run as
administrator*) and run:

```powershell
wsl --install --no-distribution
```

**Restart your PC** when it finishes. To check it worked, open PowerShell and run `wsl --status`.

**2. Install Git** (the tool that downloads BitBull and keeps it up to date):

```powershell
winget install --id Git.Git -e
```

Close PowerShell and open a new one so it can find Git.

**3. Download BitBull.** This copies BitBull from GitHub into a new folder called `BitBull` inside
your user folder, `C:\Users\<your name>\BitBull`. Paste these three lines into PowerShell (all
three at once is fine) and press **Enter**:

```powershell
cd $HOME
git clone https://github.com/bitbull-tech/BitBull.git
cd BitBull
```

You'll see `Cloning into 'BitBull'...` and a few progress lines. When it's done, the line before
your cursor ends in **`\BitBull>`**: that means you're inside BitBull's folder.

- **Run every command from here on in this same window**, from this folder.
- If you close PowerShell, open a new one and run `cd $HOME\BitBull` to get back.
- If it says `destination path 'BitBull' already exists`, you've downloaded it before: run
  `cd $HOME\BitBull` then `git pull` to bring it up to date, and carry on.

**4. Add your keys.** Create your settings file and open it in Notepad:

```powershell
copy .env.example .env
notepad .env
```

Fill in `SAYGM_API_KEY`, `DITTO_API_KEY` and `APP_TOKEN`, then save. To make a strong
`APP_TOKEN`, run this and paste the result:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''
```

**5. Create BitBull's private Linux computer** (once; downloads Ubuntu and sets it up, about 10
minutes):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\setup.ps1
```

**6. Build BitBull inside it:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\deploy.ps1
```

**7. Start it, and have it start whenever you log in:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\start.ps1 -InstallAtLogin
```

**8. Open BitBull** at **http://localhost:8787** and sign in with your `APP_TOKEN`.

## Everyday commands

Run these from the `BitBull` folder in PowerShell.

| To | Run |
|---|---|
| Update to the latest version | `git pull` then `powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\deploy.ps1` |
| Apply changes to `.env` | `powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\deploy.ps1` |
| Stop BitBull | `powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\start.ps1 -Stop` |
| Back up chats, projects and settings | `powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\backup.ps1 -Keep 10` |

Backups go to `Documents\BitBull backups` and include any keys saved in the app, so keep them
private.

## The BitBull desktop app (optional)

A small Windows app that runs these same steps with buttons, shows whether everything is healthy
(**Re-check** runs the checks again), opens BitBull in its own window and sits in the system tray.
While it runs it keeps the folder link helper going, so linking a folder works straight from the
UI, and it registers push-to-talk. **Quit** closes the app and leaves BitBull running; **Stop
BitBull and quit** shuts both down. There's no published download yet;
for now it's built on your PC from the `desktop` folder
([instructions](https://github.com/bitbull-tech/BitBull/blob/main/desktop/README.md)).

The app isn't code-signed yet, so Windows shows "Windows protected your PC": choose **More info →
Run anyway**. If **Smart App Control** is on (the default on a fresh Windows 11), the app is
blocked outright. Don't turn Smart App Control off (it can't be turned back on without
reinstalling Windows); use the steps above instead, which need no app at all.

## Advanced

- **Try a branch before merging it.** A second, separate BitBull on port 8788 with its own empty
  data, built from whatever is checked out:
  `powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\test-stack.ps1`
  (`-Logs` to follow it, `-Down` to stop, `-Destroy` to delete its data).
- **Where everything lives**, and how each layer is locked down:
  [How it is locked down](/guide/security).
- **Linking your folders** read-only, or copying big folders in:
  [Files, folders and windows](/guide/files).

## If something goes wrong

| You see | Do this |
|---|---|
| `0x80370102` or "virtualization" when installing WSL | Turn on virtualization (Intel VT-x / AMD-V or SVM) in your PC's BIOS/UEFI settings, then try step 1 again |
| `git` or `winget` "is not recognized" | Close PowerShell and open a new one; if `winget` is missing, install **App Installer** from the Microsoft Store |
| "running scripts is disabled on this system" | Run the script exactly as shown, starting `powershell -ExecutionPolicy Bypass -File` |
| http://localhost:8787 doesn't load | Run step 7 again, wait a minute, and check the [Activity log](/guide/everyday) |
