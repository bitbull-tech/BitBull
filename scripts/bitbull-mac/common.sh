# Shared by every script in scripts/bitbull-mac/. Sourced, never run on its own.
#
# BitBull on a Mac: the same three containers as on Windows (agent, egress proxy, localhost-only
# gateway), run either in a dedicated Colima VM called "bitbull" (the default: BitBull's own Linux VM,
# like the bitbull WSL distro on Windows) or in a Docker engine the user already runs (Docker Desktop,
# OrbStack). Everything BitBull keeps lives in one folder:
#
#   ~/Library/Application Support/BitBull/
#     app/        the code the containers are built from (deploy.sh copies the checkout here)
#     data/       chats, projects, uploads, settings: /data in the container
#     links/      read-only copies of folders you linked: /links in the container
#     links.tsv   which folder each link was copied from
#     runtime     "colima" or "docker"
#
# Written for the bash that ships with macOS (3.2): no associative arrays, no ${x,,}, no mapfile.
# Arguments to programs are always passed as separate words, never as a command string built
# from data.

set -u

# A GUI app (the launcher) and a LaunchAgent start with a bare PATH; Homebrew lives in one of these.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

BB_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BB_REPO="$(cd "$BB_SCRIPTS/../.." && pwd -P)"
BB_HOME="${BITBULL_HOME:-$HOME/Library/Application Support/BitBull}"
BB_APP="$BB_HOME/app"
BB_DATA="$BB_HOME/data"
BB_LINKS="$BB_HOME/links"
BB_PROFILE="${BITBULL_PROFILE:-bitbull}"
BB_PORT="${BITBULL_PORT:-8787}"
BB_MIN_MACOS=13

say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
# die "message" [exit code]
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

case "$BB_PROFILE" in
  ''|*[!A-Za-z0-9._-]*) die "Bad profile name: $BB_PROFILE (letters, digits, . _ - only)" ;;
esac

# "colima" or "docker"; setup.sh writes it
bb_runtime() {
  if [ -f "$BB_HOME/runtime" ]; then
    case "$(cat "$BB_HOME/runtime")" in
      docker) echo docker; return ;;
    esac
  fi
  echo colima
}

# Point the docker CLI at the right engine. For Colima that is the profile's own context, so a
# Docker Desktop the user also runs is never touched by BitBull, and the other way round.
bb_use_engine() {
  if [ "$(bb_runtime)" = colima ]; then
    export DOCKER_CONTEXT="colima-$BB_PROFILE"
  else
    unset DOCKER_CONTEXT
  fi
}

bb_docker_up() { docker info >/dev/null 2>&1; }

# `docker compose` (the plugin) where it works, else the standalone docker-compose from Homebrew.
bb_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    die "docker compose is not installed. With Homebrew: brew install docker-compose"
  fi
}

# The compose environment every script uses: build from the deployed copy, data and links in
# BitBull's folder. The project name stays "bitbull" so container names match Windows.
bb_compose_env() {
  export COMPOSE_PROJECT_NAME=bitbull
  export COMPOSE_FILE="docker-compose.yml:docker-compose.dev.yml"
  export BITBULL_DATA_DIR="$BB_DATA"
  export BITBULL_HOST_DATA_DIR="$BB_DATA"
  export BITBULL_LINKS_DIR="$BB_LINKS"
  export BITBULL_PORT="$BB_PORT"
}

bb_macos_major() { sw_vers -productVersion 2>/dev/null | cut -d. -f1; }

bb_check_macos() {
  [ "$(uname -s)" = Darwin ] || die "These scripts are for macOS. On Windows use scripts/bitbull-wsl; on Linux, docker compose directly."
  local major
  major="$(bb_macos_major)"
  case "$major" in ''|*[!0-9]*) die "Could not read the macOS version." ;; esac
  if [ "$major" -lt "$BB_MIN_MACOS" ]; then
    die "BitBull needs macOS $BB_MIN_MACOS (Ventura) or later; this Mac runs $(sw_vers -productVersion). The sandbox runtimes (Colima's Apple virtualisation, Docker Desktop) no longer support older releases."
  fi
}

bb_health() { curl -fsS --max-time 3 "http://127.0.0.1:$BB_PORT/api/health" >/dev/null 2>&1; }

bb_wait_health() {
  local until=$(( $(date +%s) + ${1:-240} ))
  while [ "$(date +%s)" -lt "$until" ]; do
    bb_health && return 0
    sleep 2
  done
  return 1
}

bb_start_engine() {
  bb_use_engine
  if [ "$(bb_runtime)" = colima ]; then
    command -v colima >/dev/null 2>&1 || die "Colima isn't installed: run setup first (Set up in the launcher, or scripts/bitbull-mac/setup.sh)."
    if ! colima status --profile "$BB_PROFILE" >/dev/null 2>&1; then
      say "Starting the $BB_PROFILE VM (Colima)"
      # no flags: the VM keeps the CPU, memory, disk and mount it was created with in setup.sh
      colima start --profile "$BB_PROFILE" || die "colima start failed"
    fi
  fi
  local i=0
  while [ $i -lt 30 ]; do
    bb_docker_up && return 0
    sleep 2
    i=$((i + 1))
  done
  if [ "$(bb_runtime)" = docker ]; then
    die "Docker isn't answering. Start Docker Desktop or OrbStack, then try again."
  fi
  die "Docker in the $BB_PROFILE VM didn't answer within 60s. Try: colima stop --profile $BB_PROFILE && colima start --profile $BB_PROFILE"
}
