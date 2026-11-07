#!/bin/bash
# The launcher's checks on a Mac, one per line: name<TAB>1|0<TAB>detail
#   runtime     Colima installed (or the shared Docker engine chosen)
#   vm          the bitbull VM running (or that engine running)
#   docker      Docker answering
#   containers  BitBull's containers, name: state
# Quick and read-only: it never starts or changes anything.
source "$(dirname "$0")/common.sh"

line() { printf '%s\t%s\t%s\n' "$1" "$2" "$3"; }
rt="$(bb_runtime)"
bb_use_engine

if [ "$rt" = colima ]; then
  if command -v colima >/dev/null 2>&1; then
    line runtime 1 "Colima $(colima version 2>/dev/null | awk 'NR == 1 { print $3 }') · BitBull's own VM"
    if colima status --profile "$BB_PROFILE" >/dev/null 2>&1; then
      line vm 1 "the $BB_PROFILE VM is running"
    elif colima list 2>/dev/null | awk 'NR > 1 { print $1 }' | grep -qx "$BB_PROFILE"; then
      line vm 0 "the $BB_PROFILE VM is stopped (press Start)"
    else
      line vm 0 "no $BB_PROFILE VM yet (run First-time setup)"
    fi
  else
    line runtime 0 "not set up yet: run First-time setup (installs Colima with Homebrew)"
    line vm 0 "no $BB_PROFILE VM yet"
  fi
else
  if command -v docker >/dev/null 2>&1; then
    line runtime 1 "the Docker engine you already run (Docker Desktop or OrbStack)"
  else
    line runtime 0 "no docker command: install Docker Desktop or OrbStack, or set up with Colima"
  fi
  if bb_docker_up; then
    line vm 1 "$(docker info --format '{{.Name}} · {{.OperatingSystem}}' 2>/dev/null) is running"
  else
    line vm 0 "Docker isn't running: start Docker Desktop or OrbStack"
  fi
fi

if v="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" && [ -n "$v" ]; then
  line docker 1 "Docker $v"
else
  line docker 0 "not answering (press Start)"
  line containers 0 "unknown until Docker answers"
  exit 0
fi

if [ ! -f "$BB_APP/docker-compose.yml" ]; then
  line containers 0 "no containers yet (run Deploy)"
  exit 0
fi
bb_compose_env
rows="$(cd "$BB_APP" && bb_compose ps -a --format '{{.Name}} {{.State}}' 2>/dev/null)"
if [ -z "$rows" ]; then
  line containers 0 "no containers yet (run Deploy)"
  exit 0
fi
total=$(printf '%s\n' "$rows" | grep -c .)
running=$(printf '%s\n' "$rows" | awk '$2 == "running"' | grep -c .)
detail="$(printf '%s\n' "$rows" | awk '{ printf "%s%s: %s", (NR > 1 ? ", " : ""), $1, $2 }')"
line containers "$([ "$running" = "$total" ] && echo 1 || echo 0)" "$detail"
