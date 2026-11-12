## Before you start

- macOS 13 (Ventura) or later, Apple Silicon or Intel
- About 10 GB of free disk space
- Your three keys ([see Getting started](/guide/getting-started#before-you-start-three-keys))

Mac support is new and still being tested. If something doesn't work, please
[open an issue](https://github.com/bitbull-tech/BitBull/issues).

### How it runs on a Mac

BitBull gets its own small Linux virtual machine, called `bitbull`, made with a free tool called
**Colima**. That VM only ever sees BitBull's own folder (`~/Library/Application Support/BitBull`),
not the rest of your Mac. If you already use **Docker Desktop** or **OrbStack**, BitBull can use
that instead (see Option 3).

## Option 1: let your AI agent do it (easiest)

If you use an AI coding agent on this Mac, paste this into it:

```text
Set up BitBull for me. Fetch https://www.bitbull.tech/get-started.md and follow it.
```

## Option 2: step by step

Open **Terminal** (Applications → Utilities) and paste each command.

> **How to paste a command:** click the copy button on the grey box (or select the text and press
> ⌘C), click inside the Terminal window, press **⌘V**, then press **Return**. Wait until it
> finishes and you see the cursor again before pasting the next one. If Terminal asks for your
> password, type your Mac login password (nothing appears as you type) and press Return.

**1. Install Homebrew** (the standard Mac package manager), if you don't have it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the two lines it prints at the end to add Homebrew to your PATH.

**2. Install Git:**

```bash
brew install git
```

**3. Download BitBull.** This copies BitBull from GitHub into a new folder called `BitBull` in your
home folder (`/Users/<your name>/BitBull`). Paste these three lines and press **Return**:

```bash
cd ~
git clone https://github.com/bitbull-tech/BitBull.git
cd BitBull
```

You'll see `Cloning into 'BitBull'...` and a few progress lines. When it's done, the line before
your cursor shows **`BitBull`**: you're inside BitBull's folder.

- **Run every command from here on in this same window**, from this folder.
- If you close Terminal, open a new one and run `cd ~/BitBull` to get back.
- If it says `destination path 'BitBull' already exists`, you've downloaded it before: run
  `cd ~/BitBull` then `git pull` to bring it up to date, and carry on.

**4. Add your keys.** Create your settings file and open it in TextEdit:

```bash
cp .env.example .env
open -e .env
```

Fill in `SAYGM_API_KEY`, `DITTO_API_KEY` and `APP_TOKEN`, then save. To make a strong
`APP_TOKEN`, run `openssl rand -hex 32` and paste the result.

**5. Set up and start BitBull** (once; installs Colima if needed, creates the VM and builds
BitBull, about 10 minutes):

```bash
bash scripts/bitbull-mac/setup.sh
```

**6. Start BitBull whenever you log in:**

```bash
bash scripts/bitbull-mac/start.sh --install-at-login
```

**7. Open BitBull** at **http://localhost:8787** and sign in with your `APP_TOKEN`.

## Option 3: you already run Docker Desktop or OrbStack

Do steps 1 to 4, then use your existing engine instead of a new VM:

```bash
bash scripts/bitbull-mac/setup.sh --runtime docker
bash scripts/bitbull-mac/start.sh --install-at-login
```

BitBull's containers then share that engine with whatever else you run.

## Everyday commands

Run these from the `BitBull` folder in Terminal.

| To | Run |
|---|---|
| Update to the latest version | `git pull && bash scripts/bitbull-mac/deploy.sh` |
| Apply changes to `.env` | `bash scripts/bitbull-mac/deploy.sh` |
| Stop BitBull | `bash scripts/bitbull-mac/start.sh --stop` |
| Back up chats, projects and settings | `bash scripts/bitbull-mac/backup.sh --keep 10` |

Backups go to `~/Documents/BitBull backups`.

## The BitBull desktop app (optional)

The same launcher as on Windows: health checks, buttons for these scripts, BitBull in its own
window, and it lives in the menu bar. It also handles linking folders and keeps the vault key in
your login Keychain. There's no published download yet; the `.dmg` is built by the repo's `macos`
GitHub workflow ([details](https://github.com/bitbull-tech/BitBull/blob/main/desktop/README.md)).
It isn't signed yet, so the first time, right-click **BitBull → Open**.

## Good to know

- **Linked folders are copies on a Mac.** The agent reads a copy kept in BitBull's folder; press
  **Refresh** in Settings → Folders after changing the original.
- **Sizing the VM:** `setup.sh --cpus 4 --memory 8 --disk 60` (memory and disk in GB).
