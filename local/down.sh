#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Stop the Local course's stacks.
#
#   local/down.sh            # stop everything; your topic, view, and agents stay
#   local/down.sh --reset    # also delete all of it, to start over from Lab 0
#
# `ork local stop` on its own leaves the AI Gateway container running (ork
# v0.6.0), and deleting only the engine's volumes, or only .lab/ork, leaves an
# engine that cannot start again. This script does the whole sequence.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

reset=false
case "${1:-}" in
  "") ;;
  --reset) reset=true ;;
  *) die "usage: local/down.sh [--reset]" ;;
esac

command -v docker >/dev/null || die "docker is not installed."
project=$(engine_project)

# Detach the MCP server from the engine's network, so that network can go.
mcp=$(mcp_container)
if [ -n "$mcp" ]; then
  docker network disconnect "${project}_default" "$mcp" >/dev/null 2>&1 || true
fi

# The engine. `down` by project name also removes the gateway, and needs no file.
# Without --reset, `rm --volumes` goes first: `down` alone keeps the unnamed
# volumes that some images declare, and the next start makes new ones beside
# them. Your data is in named volumes, which `rm --volumes` does not touch. It
# is quiet and may fail: `down` stops whatever it left.
if $reset; then
  docker compose --progress quiet --project-name "$project" down -v --remove-orphans
else
  docker compose --progress quiet --project-name "$project" rm --stop --force --volumes >/dev/null 2>&1 || true
  docker compose --progress quiet --project-name "$project" down --remove-orphans
fi

# The streaming stack.
if $reset; then
  streaming down -v --remove-orphans
else
  streaming rm --stop --force --volumes >/dev/null 2>&1 || true
  streaming down --remove-orphans
fi

if $reset; then
  # The engine's keys go with its volumes: one without the other cannot start again.
  case "$ORK_DIR" in
    "$REPO_ROOT"/.lab/ork) rm -rf "$ORK_DIR" ;;
    *) die "Refusing to delete $ORK_DIR: it is not this checkout's .lab/ork." ;;
  esac
  # Ids and the key of an engine that no longer exists.
  rm -f "$REPO_ROOT"/.orca-state/*.local.json
  if [ -f "$REPO_ROOT/.env" ] && [ "$(env_value TUTORIAL_STACK "$REPO_ROOT/.env")" = local ]; then
    rm -f "$REPO_ROOT/.env"
  fi
  echo "Stopped and deleted the local stacks, their data, and the local .env. Start over at labs/local/00-set-up.md."
else
  echo "Stopped the local stacks. Your data is kept: start again with"
  echo "  docker compose -f local/compose.yaml up -d --wait && local/engine.sh"
fi
