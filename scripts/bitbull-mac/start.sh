#!/bin/bash
# Start BitBull (the runtime, then the containers) and wait until it answers.
#
#   scripts/bitbull-mac/start.sh
#   ... --stop                  stop the containers, and the bitbull VM when it is Colima's
#   ... --install-at-login      start BitBull, and the BitBull app (which holds the link helper),
#                               every time you log in
#   ... --uninstall-at-login
#
# The link helper (folder picker, Open in Finder, vault key for BitBull's page) runs inside the
# BitBull app on a Mac, so linking folders and unlocking the vault need the app running; the
# stack itself does not.
source "$(dirname "$0")/common.sh"

AGENT_LABEL="io.bitbull.stack"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"

case "${1:-}" in
  --stop)
    bb_use_engine
    if bb_docker_up && [ -f "$BB_APP/docker-compose.yml" ]; then
      bb_compose_env
      (cd "$BB_APP" && bb_compose stop)
    fi
    if [ "$(bb_runtime)" = colima ] && command -v colima >/dev/null 2>&1; then
      say "Stopping the $BB_PROFILE VM"
      colima stop --profile "$BB_PROFILE"
    fi
    say "BitBull stopped."
    exit 0
    ;;
  --uninstall-at-login)
    launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
    rm -f "$AGENT_PLIST"
    say "BitBull no longer starts at login."
    exit 0
    ;;
  --install-at-login|--at-login|"") ;;
  *) die "Unknown option: $1" ;;
esac
MODE="${1:-}"

bb_check_macos
bb_start_engine
bb_compose_env
if [ -f "$BB_APP/docker-compose.yml" ]; then
  say "Starting the containers"
  (cd "$BB_APP" && bb_compose up -d 2>&1 | tail -n 4)
else
  warn "No deployed code yet: run deploy.sh (or Deploy in the launcher)."
fi

if bb_wait_health 240; then
  say "BitBull is up: http://localhost:$BB_PORT"
else
  warn "BitBull didn't answer within 4 minutes. What the containers say:"
  (cd "$BB_APP" && bb_compose ps -a; echo; bb_compose logs --tail 15 bitbull-agent)
fi

if [ "$MODE" = --at-login ]; then
  # started by the LaunchAgent: bring the app up in the background too, for the link helper
  open -g -b io.bitbull.desktop 2>/dev/null || true
fi

if [ "$MODE" = --install-at-login ]; then
  mkdir -p "$HOME/Library/LaunchAgents" "$BB_HOME/logs"
  # Written with plutil, not by pasting paths into XML: the repo path may hold any character.
  rm -f "$AGENT_PLIST"
  plutil -create xml1 "$AGENT_PLIST"
  plutil -insert Label -string "$AGENT_LABEL" "$AGENT_PLIST"
  plutil -insert ProgramArguments -array "$AGENT_PLIST"
  plutil -insert ProgramArguments -string /bin/bash -append "$AGENT_PLIST"
  plutil -insert ProgramArguments -string "$BB_SCRIPTS/start.sh" -append "$AGENT_PLIST"
  plutil -insert ProgramArguments -string --at-login -append "$AGENT_PLIST"
  plutil -insert RunAtLoad -bool true "$AGENT_PLIST"
  plutil -insert StandardOutPath -string "$BB_HOME/logs/start-at-login.log" "$AGENT_PLIST"
  plutil -insert StandardErrorPath -string "$BB_HOME/logs/start-at-login.log" "$AGENT_PLIST"
  launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST" 2>/dev/null || true
  say "BitBull now starts at login ($AGENT_PLIST)."
  note "Undo with: scripts/bitbull-mac/start.sh --uninstall-at-login"
fi
