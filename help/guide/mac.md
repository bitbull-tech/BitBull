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
that instead (see Option 4).

## Option 1: one command (easiest)

Open **Terminal** (press ⌘ Space, type **Terminal**, press Return), paste this line and press
**Return**:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/bitbull-tech/BitBull/main/scripts/bitbull-mac/install.sh)"
```

That is the whole install. It doesn't ask you anything, with one exception: if **Homebrew** (the
standard Mac installer for developer tools) isn't on your Mac yet, it asks for your **Mac login
password** once. Nothing appears as you type it; that is normal. Type it and press Return.

About 10 minutes later **the BitBull app** opens: BitBull in its own window, already signed in,
with an icon in the menu bar. The installer puts the app in your Applications folder for you. If
it can't get the app (for example, you're offline at that moment), BitBull opens in your browser
instead, signed in just the same; run the command again later to get the app.

Its first screen, **Finish setting up**, asks for the two things only you have:

1. **SayGM** (the AI models): [get a key at saygm.com](https://saygm.com) and paste it into the box.
2. **Ditto** (BitBull's memory): press **Connect Ditto** and sign in, or sign up free, in your
   browser. There is no key to copy.

BitBull and its app then start every time you log in. From the menu-bar icon you can open
BitBull, check it's healthy, stop it or update it. Prefer a browser tab? It's always at
**http://localhost:8787** too.

What the command did for you: installed Homebrew and Git if they were missing (and set Homebrew
up for new Terminal windows, a step it otherwise leaves to you), downloaded BitBull into a
`BitBull` folder in your home folder, and made a strong password for it (`APP_TOKEN`). You only
need that password to sign in from another browser or device:

```bash
grep APP_TOKEN ~/BitBull/.env
```

Run the same command again any time to update BitBull; it keeps your settings. Already using
Docker Desktop or OrbStack? See Option 4.

## Option 2: let your AI agent do it

If you use an AI coding agent on this Mac, paste this into it:

```text
Set up BitBull for me. Fetch https://www.bitbull.tech/get-started and follow it.
```

## Option 3: step by step

Open **Terminal** (Applications → Utilities) and paste each command.

> **How to paste a command:** click the copy button on the grey box (or select the text and press
> ⌘C), click inside the Terminal window, press **⌘V**, then press **Return**. Wait until it
> finishes and you see the cursor again before pasting the next one. If Terminal asks for your
> password, type your Mac login password (nothing appears as you type) and press Return.
>
> Paste only the command itself. Terminal on a Mac uses **zsh**, which doesn't skip a `#` note
> after a command the way other shells do, so a pasted note would be passed to the command.

**1. Install Homebrew** (the standard Mac package manager), if you don't have it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

At the end it prints **Next steps** with lines to add Homebrew to your PATH. On an Apple Silicon
Mac (M1 or later) they come to these two; paste them so `brew` works in this window and new ones:

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Check with `brew --version`. If it says `command not found: brew`, close Terminal, open a new
window and try again.

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

**4. Add your keys.** Create your settings file and open it in Terminal's own editor:

```bash
cp .env.example .env
nano .env
```

Use the arrow keys to move to each line and fill in `SAYGM_API_KEY`, `DITTO_API_KEY` and
`APP_TOKEN` after the `=` (no spaces, no quotes). To paste, press ⌘V. Save with **Ctrl+O** then
Return, and leave with **Ctrl+X**. For a strong `APP_TOKEN`, run `openssl rand -hex 32` first and
copy the result.

Why not TextEdit: it can quietly turn `"` into curly “smart” quotes, which breaks the file. The
file name starts with a dot, so Finder hides it; ⌘⇧. (Command, Shift, full stop) shows hidden
files.

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

## Option 4: you already run Docker Desktop or OrbStack

With the one command from Option 1, add ` --runtime docker` after it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/bitbull-tech/BitBull/main/scripts/bitbull-mac/install.sh)" -- --runtime docker
```

Or step by step: do steps 1 to 4 of Option 3, then use your existing engine instead of a new VM:

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

## The BitBull app

The one command in Option 1 installs it. It gives you BitBull in its own window, health checks,
buttons for the everyday commands, and a menu-bar icon. It also handles linking folders and keeps
the vault key in your login Keychain, so those two need the app running.

- **Installed BitBull step by step?** Download the app from
  [the latest release](https://github.com/bitbull-tech/BitBull/releases/latest) (`BitBull-macos.dmg`),
  open it and drag BitBull into Applications. Or run the one command from Option 1: it keeps
  your settings and adds the app.
- **"Apple cannot check it":** the app isn't notarised by Apple yet. If macOS says this the first
  time, right-click **BitBull** in Applications and choose **Open**, once.
- **Rather not use the app?** Add ` -- --browser` to the end of the one command, and use
  **http://localhost:8787**. Linking folders then needs the app, or the commands in
  [Files, folders and windows](/guide/files).

## Good to know

- **Always start the scripts with `bash`**, as shown. They are written for the version of bash
  that comes with macOS; `./setup.sh` or `sh setup.sh` can fail.
- **`command not found: brew`** in a new window means Homebrew isn't on your PATH: see step 1 of
  Option 3, or run the one command again, which fixes it.
- **`zsh: command not found: #`** or `Unknown option: #` means a note after `#` was pasted with a
  command. Paste just the command.

- **Linked folders are copies on a Mac.** The agent reads a copy kept in BitBull's folder; press
  **Refresh** in Settings → Folders after changing the original.
- **Sizing the VM:** `setup.sh --cpus 4 --memory 8 --disk 60` (memory and disk in GB).
