## Files and folders
**Files** (top bar, or the folder icon on a project) browses a project's workspace, sortable by
name, kind, size or modified time, and shows the folder's real path inside the container and on
the host (copy buttons) so you can open the same place with `wsl -d bitbull`. It adds
local files or whole folders, keeping their structure and skipping `node_modules`, `.git`
and build output. In the chat, the paperclip attaches files and the folder button offers
**Upload a copy** or one of your **linked folders**.

### Copy or link?

| | Copy in | Linked folder |
|---|---|---|
| Use it for | building, storing, anything the agent should change | reviews and analysis of your real files |
| What the agent gets | its own copy in the workspace (read-write) | your folder in place at `/links/<name>`, **read-only, no-exec** |
| Your original | never touched | can't be changed, deleted or encrypted (the kernel refuses writes) |
| How | folder button → Upload a copy, drag and drop, or `copy-in.ps1` for big folders | folder button → **Link a folder from this PC…** (or Settings → Folders): a Windows folder picker opens on the PC and you choose there. Also `link.ps1` |
| Who can see it | that workspace's chats | **every chat in this BitBull**; attaching it tells a chat to use it |

```powershell
# copy a big folder in, fast (no browser); -Project "<name>" for a project's workspace
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\copy-in.ps1 -Path "D:\code\my-project" -Project "My Project"

# link a folder read-only: pick it in a dialog, or give the path
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -Add "D:\Projects\specs"
# once: "Link to BitBull (read-only)" on Explorer's right-click menu for folders (-UninstallMenu removes it)
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -InstallMenu
# a folder with secrets: a read-only copy without them (BitBull's own repo always links this way)
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -Add "C:\code\BitBull" -Hide
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -Refresh bitbull
# list links (also re-mounts missing ones), remove one
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -List
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -Remove specs
```

**Linking with the mouse.** The page can't see your disks and never sends a path. It asks the
**link helper** (`scripts/bitbull-wsl/link-helper.ps1`, kept running by the BitBull app, or started hidden by `start.ps1` when you don't use the app; listening on
`http://localhost:8790` only), which opens a Windows folder picker on the PC. Nothing is linked
unless you pick a folder there; if the folder holds keys, `.env` files or wallets, a Windows box
asks how to link it (below). The helper then runs `link.ps1`, so every check below applies. It only
answers BitBull's own page (Origin `http://localhost:8787`/`8788`), and the agent can't reach it at all
(its proxy refuses local addresses). Linking therefore works from the PC BitBull runs on, not from a
phone or another computer.

**Folders that hold secrets** (BitBull's own repo, any project with a `.env`) are linked as a
**filtered copy**: a read-only copy that leaves out `.env` (templates like `.env.example` stay),
keys, wallets, browser login stores, `node_modules`/caches and, for BitBull's repo, `data\` too. The
agent never sees those files, because they aren't there. Hiding files inside a live Windows
mount isn't reliable (Windows names are case-insensitive and have 8.3 short aliases, so a hidden
`.env` could still be opened as `.ENV` or `ENV~1`), which is why it's a copy: the folder is
mounted read-only somewhere only root in the distro can see, copied without the hidden paths,
and unmounted again. The copy changes only when you press **Refresh** (Settings → Folders, or
`link.ps1 -Refresh <name>`), which re-scans the folder for secrets first. Git history in a
linked repo is included, so a secret that was ever committed is still in `.git`.

How a link is held shut, layer by layer:

1. The `bitbull` distro sees no Windows drives (automount off). `link.ps1` mounts just that folder at
   `/srv/bitbull-links/<name>` with `ro,noexec,nosuid,nodev`, checks that a write fails, and only
   then records it. Only root in the distro can mount, and only you reach root there (from
   Windows). Links come back at boot from `/etc/bitbull-links`.
2. `bitbull-agent` gets `/srv/bitbull-links` at `/links` read-only. Its users are remapped to nobodies in
   the distro, it has no capabilities and can't mount or remount anything.
3. BitBull reads each link's mount flags from `/proc/self/mountinfo` and never hands a chat a link
   that isn't read-only.
4. Symlinks and junctions inside a linked folder resolve inside the container, so they can't
   lead anywhere else on Windows.
5. Adding or removing a link restarts every BitBull container that mounts them (about 10 s), so a
   removed link is really gone.

Both scripts refuse whole drives, network paths, Windows/program/app-data folders, your profile
root and BitBull's own repo (its `.env` holds BitBull's keys), and stop if the folder holds anything that
looks like keys, passwords or wallets (`.env`, `.ssh`, `*.pem`, `id_*`, `*.kdbx`, wallet and
seed files, browser login stores…; `-AllowSecrets` overrides). The check runs once, so don't
save secrets into a linked folder later. `copy-in.ps1` unpacks as the container's unprivileged
user, never as root, and only accepts plain path characters.

What a link can't protect against: anything the agent reads may be sent to the model it uses,
and to sites on the allowlist or that you approve. Escaping the container would need a flaw in
Docker, WSL or the kernel, so keep Windows and WSL updated. To confirm the container can't talk
to Windows' file server directly (Docker's default seccomp profile blocks `AF_VSOCK`):

```powershell
wsl -d bitbull --exec docker exec bitbull-agent python3 -c "import socket; socket.socket(40, socket.SOCK_STREAM)"
# expected: PermissionError / Operation not permitted
```

### Changing files in a linked folder

The agent only ever reads a linked folder. A change reaches it one way: the agent writes the new
files in its workspace and hands them over, and the link helper on your PC writes them in.

- **You are asked once per folder, in each project.** The first time the agent has a change for a
  folder, the card offers **Allow changes in this folder and write** (a box on the PC asks you to
  confirm, naming the project). You can also allow it beforehand from the **Resources** panel.
  The permission is that project's: add the same folder to another project and it starts
  read-only there.
- **After that, changes are written straight away.** Each one appears in the chat corner with its
  files and diffs, an **Undo**, and, when the files are in a git repo, the commands to review and
  publish it (`git status`, `git diff`, `git add`, `git commit`, `git push`) with a Copy button.
  The agent gives the same commands in its reply. BitBull never runs git in your folder.
- **Undo** puts back what was replaced or deleted and removes what was created. A file you have
  changed since is left alone and named. What a change replaces is also kept under
  `%LOCALAPPDATA%\BitBull\folder-backups`.
- **Put it on a branch instead** (for files in a git repo, while the folder is still read-only):
  the helper creates `bitbull/<name>` from the repo's current commit and leaves your working
  files alone. **Decline** changes nothing.
- **Folders with secrets work too.** A folder holding `.env` files, keys or wallets is read as a
  copy without them. Changes are written to your real folder and the copy is refreshed. A file
  BitBull was never shown (hidden, or added since the last refresh) is not overwritten.

What keeps this safe:

- **What is written is what was shown.** Each file's hash goes to the helper; a file that
  changed since it was staged is refused and nothing is written.
- **Your own edits are not overwritten.** Each change also carries the hash of every file as the
  agent read it. If a file in your folder is no longer that (you edited it, or it appeared or
  went since), the whole change is refused, nothing is written, and the agent is told. Refresh
  the folder if it is a copy, and ask again.
- **Some files are never written**, because they run on your PC without you choosing to run
  them, or hold secrets: `.git` (hooks, config), `.gitconfig`, `.githooks`, `.husky`, `.vscode`,
  `.idea`, `.devcontainer`, `.github/workflows`, shell start-up files, `.envrc`, `.env` and
  `.env.*` (templates like `.env.example` are fine), and programs and shortcuts (`.exe`, `.dll`,
  `.lnk` and the like). Nothing is written through a junction or symbolic link either, so a
  change can't leave the folder.
- **Deleting is a separate permission** (Allow deleting, per folder). Deleted files go to the
  Recycle Bin, with a copy in the backup folder.
- **Read-only when nobody is watching.** Scheduled runs and Telegram messages can't change a
  linked folder, and a change is only written while BitBull is open on the PC.
- **Listed and removable.** The Resources panel shows what its project may do in each folder,
  with **Make read-only** for that project. Settings → Folders lists every folder and the
  projects allowed to change it, with **Make read-only** for all of them. Neither asks a
  question. Removing a link removes its permissions.

Changes work on Windows for now; on a Mac, links are read-only copies.

### Folders belong to a project

A folder is linked for the project you link it from (or for the general workspace, outside a
project). Only that project's chats are offered it, can attach it, or can change it; add it to
another project from that project's Resources panel. Settings → Folders lists every folder
linked on the PC and which projects use it. This is about what BitBull offers and accepts: every
linked folder is still mounted in the one sandbox, so it is not a wall between projects.

### The Resources panel

**Resources** sits in the right margin, under the top row: a panel showing what this project is
working with (fold it to a slim tab with its ×, and click the tab to bring it back): its linked folders (with **Link a folder…**, live progress while one is being
linked, and **Allow changes**), the repositories and uploads in its workspace, its integrations,
the installed skills and the web addresses you have allowed. It is open by default on a wide
screen and remembers whether you closed it.

The rules live in `scripts/bitbull-wsl/folder-apply.ps1` (tests beside it) and
`server/src/folderChanges.ts`; a test keeps the two lists of protected paths the same.

## Getting files out (no command line)
Whatever the agent writes, a brief, an image, a script, a whole folder, can be taken out without a shell:

- **Under each reply**, *N files from this reply* lists what that reply created or changed in the
  workspace, including files made by scripts it ran. Each file has **Download** and **Show in
  Explorer** (Finder on a Mac: the folder opens with the file selected); **Download all** saves
  them as one .zip and **Open in Explorer** opens the folder they're in.
- **Files** (the folder button on a project, or the workspace) has the same per file, plus
  **Download folder (.zip)** for whatever folder you are in.

Downloads go wherever your browser (or the desktop app) saves files, normally Downloads. They are
always saved, never opened inside BitBull, so nothing an agent writes can run in the page. Showing
in Explorer needs the link helper (the BitBull app keeps it running; without the app, `start.ps1`) and works on the
computer BitBull runs on. Endpoints: `GET /api/sessions/:id/outputs`, `GET /api/projects/:id/download?path=…`
(repeat `path` for several; folders and several files come as a .zip, up to 5,000 files / 512 MB).

## Opening folders in Explorer
The Files view shows each folder's path inside the container and inside the `bitbull` distro;
**Open in Explorer** opens it on Windows (`\\wsl.localhost\bitbull\…`) through the link helper,
which only opens folders under `bitbull-data`. `start.ps1` makes the data folder traversable for
this; `settings.local.json` and `vault.json` stay owner-only.

## Showing BitBull a window or a web page
- **Show BitBull a window** (the screen button by the paperclip): pick a window in your browser's
  share dialog and a picture of it is attached to your message. While you keep sharing, every
  message you send carries a fresh picture of it; the "Showing: …" chip stops it. Any model that
  reads images can then review what you see.
- **The BitBull browser extension** (`browser-extension/`, load it unpacked in Chrome or Edge):
  click it (or Alt+Shift+B) on any page and it sends a screenshot plus the page's text, outline,
  links, failed requests, images without alt text and unlabelled fields to your local BitBull,
  which attaches them to the chat you have open. It reads only the tab you're on, only when you
  click, and sends only to BitBull on this computer. See
  [browser-extension/README.md](https://github.com/bitbull-tech/BitBull/blob/main/browser-extension/README.md).

The model picker filters by maker (tick any number) and sorts by name, price or speed. With Ditto connected, **All / SayGM / Ditto Router** above the list (and in the Models view) shows the models from one or the other. The ⚡
figure is the typical time to the first word of a reply, measured from your own recent replies
on that model.
