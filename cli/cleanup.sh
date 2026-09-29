#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Remove the agent, vault, and environment your scripts created.
#
#   ./cleanup.sh
#
# Your SQL objects stay; drop them with sql/99_reset.sql.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
hello_setup ORCA_BASE_URL SN_API_KEY

remove() {  # remove <label> <state key> <ork command...>
  local id
  id=$(state_get "$2")
  [ -n "$id" ] || return 0
  if ork "${@:3}" "$id" >/dev/null 2>"$HELLO_TMP/ork.err"; then
    echo "removed $1 $id"
  elif ork_failed_with 404; then
    echo "$1 $id was already gone"
  else
    ork_fail
  fi
}

# Agents cannot be deleted, only archived.
remove agent agent_id agent archive
remove vault vault_id agent vaults delete
remove environment environment_id agent environments delete
rm -f "$HELLO_STATE_FILE"
