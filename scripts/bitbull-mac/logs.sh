#!/bin/bash
# The last 300 lines from BitBull's containers.
#   scripts/bitbull-mac/logs.sh
source "$(dirname "$0")/common.sh"
bb_use_engine
bb_docker_up || die "Docker isn't running (Start BitBull first)."
[ -f "$BB_APP/docker-compose.yml" ] || die "Not deployed yet."
bb_compose_env
cd "$BB_APP" && bb_compose logs --tail 300 --no-color
