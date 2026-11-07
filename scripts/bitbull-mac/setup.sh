#!/bin/bash
# First-time setup of BitBull on a Mac: the container runtime, BitBull's folder, the first build.
#
#   scripts/bitbull-mac/setup.sh                    a dedicated Colima VM called "bitbull" (default)
#   scripts/bitbull-mac/setup.sh --runtime docker   use the Docker Desktop / OrbStack you already run
#   ... --cpus 4 --memory 8 --disk 60               size of the Colima VM (GB for memory and disk)
#
# Colima is the closer match to the Windows build: BitBull gets its own Linux VM, which only ever
# sees BitBull's folder (~/Library/Application Support/BitBull), not the rest of your Mac. With
# Docker Desktop or OrbStack the containers share that engine with whatever else you run, and the
# engine can see whatever its own file-sharing settings allow; the containers themselves still
# only get BitBull's data and links folders.
#
# Needs macOS 13 or later. Colima is installed with Homebrew (https://brew.sh) if it is missing.
source "$(dirname "$0")/common.sh"

RUNTIME=colima
CPUS=4
MEMORY=8
DISK=60
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) RUNTIME="${2:-}"; shift 2 ;;
    --cpus) CPUS="${2:-}"; shift 2 ;;
    --memory) MEMORY="${2:-}"; shift 2 ;;
    --disk) DISK="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done
case "$RUNTIME" in colima|docker) ;; *) die "--runtime must be colima or docker" ;; esac
for n in "$CPUS" "$MEMORY" "$DISK"; do
  case "$n" in ''|*[!0-9]*) die "--cpus, --memory and --disk take whole numbers" ;; esac
done

bb_check_macos
say "BitBull on macOS $(sw_vers -productVersion) ($(uname -m)), runtime: $RUNTIME"

if [ ! -f "$BB_REPO/.env" ]; then
  die "No .env in $BB_REPO. Copy .env.example to .env, fill in APP_TOKEN, SAYGM_API_KEY and DITTO_API_KEY, then run setup again."
fi

mkdir -p "$BB_HOME" "$BB_DATA" "$BB_LINKS"
chmod 700 "$BB_HOME"
[ -f "$BB_HOME/links.tsv" ] || : > "$BB_HOME/links.tsv"

if [ "$RUNTIME" = colima ]; then
  if ! command -v colima >/dev/null 2>&1 || ! command -v docker >/dev/null 2>&1; then
    command -v brew >/dev/null 2>&1 || die "Colima is installed with Homebrew, which isn't on this Mac. Install it from https://brew.sh, then run setup again. (Or use --runtime docker with Docker Desktop or OrbStack.)"
    say "Installing Colima and the Docker command-line tools with Homebrew"
    brew install colima docker docker-compose || die "brew install failed"
  fi
  if colima list 2>/dev/null | awk 'NR > 1 { print $1 }' | grep -qx "$BB_PROFILE"; then
    note "The $BB_PROFILE VM already exists; keeping it."
  else
    say "Creating the $BB_PROFILE VM: $CPUS CPUs, ${MEMORY} GB memory, ${DISK} GB disk"
    note "It can only see BitBull's own folder: $BB_HOME"
    # vz: Apple's own virtualisation (macOS 13+), virtiofs: fast file sharing for that one folder.
    # One --mount replaces Colima's default of sharing your whole home folder.
    colima start --profile "$BB_PROFILE" \
      --cpu "$CPUS" --memory "$MEMORY" --disk "$DISK" \
      --vm-type vz --mount-type virtiofs \
      --mount "$BB_HOME:w" \
      || die "Creating the VM failed. 'colima start --profile $BB_PROFILE --verbose' shows why."
  fi
else
  unset DOCKER_CONTEXT
  command -v docker >/dev/null 2>&1 || die "No docker command. Install and start Docker Desktop or OrbStack first, or run setup without --runtime docker to use Colima."
  bb_docker_up || die "Docker isn't answering. Start Docker Desktop or OrbStack, then run setup again."
  note "Using the running engine: $(docker info --format '{{.Name}} · {{.OperatingSystem}}' 2>/dev/null)"
  note "Make sure it may share $BB_HOME (Docker Desktop: Settings → Resources → File sharing; /Users is shared by default)."
fi
printf '%s\n' "$RUNTIME" > "$BB_HOME/runtime"

bash "$BB_SCRIPTS/deploy.sh" || exit $?
bash "$BB_SCRIPTS/start.sh" || exit $?
say "Set up. BitBull: http://localhost:$BB_PORT"
