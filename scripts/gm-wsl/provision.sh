#!/usr/bin/env bash
# Runs once as root inside the fresh "gm" WSL distro (called by setup.ps1).
#   $1 = Linux user to create    $2 = repo path as seen from this distro (/mnt/d/...)
# Leaves the distro with Docker Engine (user-namespace remapped), the repo in
# ~/SayGMAgent, data in ~/gm-data, and Windows drive mounts + interop switched OFF
# from the next start.
set -euo pipefail
USER_NAME="$1"
REPO="$2"
HOME_DIR="/home/$USER_NAME"
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

rm -f /.dockerenv   # left over from the image this distro was made from

say "Base packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git rsync iproute2 procps >/dev/null

say "User $USER_NAME (no sudo: administer with 'wsl -d gm -u root' from Windows)"
id "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USER_NAME"
chmod 750 "$HOME_DIR"

say "Docker Engine"
if ! command -v dockerd >/dev/null; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh >/dev/null 2>&1 || sh /tmp/get-docker.sh
fi
mkdir -p /etc/docker
# userns-remap: root/uids inside containers map to unprivileged uids in this distro,
# so even a container escape lands as a nobody user that cannot mount drives.
cat > /etc/docker/daemon.json <<'JSON'
{
  "userns-remap": "default",
  "no-new-privileges": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
usermod -aG docker "$USER_NAME"
service docker restart >/dev/null 2>&1 || service docker start
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info --format 'Docker {{.ServerVersion}}, security: {{.SecurityOptions}}'

say "Code → $HOME_DIR/SayGMAgent"
mkdir -p "$HOME_DIR/SayGMAgent"
rsync -a --delete --exclude node_modules --exclude dist --exclude .git --exclude /data "$REPO/" "$HOME_DIR/SayGMAgent/"
sed -i 's/\r$//' "$HOME_DIR/SayGMAgent/.env" "$HOME_DIR"/SayGMAgent/egress/* 2>/dev/null || true
chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR/SayGMAgent"

say "Data → $HOME_DIR/gm-data"
mkdir -p "$HOME_DIR/gm-data"
if [ -d "$REPO/data" ]; then
  # chats DB, project workspaces, uploads, Atlas workflow specs (host-only caches and logs stay behind)
  rsync -a --exclude logs --exclude opencode --exclude claude --exclude home --exclude cache --exclude config \
    "$REPO/data/" "$HOME_DIR/gm-data/"
fi
# Container uid 1000 (node) appears as <dockremap start>+1000 in this distro
start=""
for i in $(seq 1 10); do start=$(awk -F: '$1=="dockremap"{print $2}' /etc/subuid); [ -n "$start" ] && break; sleep 1; done
[ -n "$start" ] || { echo "dockremap subuid range not found"; exit 1; }
uid=$((start + 1000))
chown -R "$uid:$uid" "$HOME_DIR/gm-data"
chmod 700 "$HOME_DIR/gm-data"
echo "gm-data owned by remapped uid $uid"

say "Locking the distro down (applies after restart)"
cat > /etc/wsl.conf <<CONF
# GM sandbox distro: no Windows drives, no launching Windows programs.
[automount]
enabled = false
mountFsTab = false

[interop]
enabled = false
appendWindowsPath = false

[user]
default = $USER_NAME

[boot]
command = /usr/local/sbin/gm-links mount-all; service docker start
CONF

say "Read-only folder links (scripts/gm-wsl/link.ps1)"
install -m 755 "$HOME_DIR/SayGMAgent/scripts/gm-wsl/gm-links.sh" /usr/local/sbin/gm-links
sed -i 's/\r$//' /usr/local/sbin/gm-links
mkdir -p /srv/gm-links && chmod 755 /srv/gm-links

say "Provisioned"
