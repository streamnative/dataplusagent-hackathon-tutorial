#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# psql against the RisingWave on your laptop, with nothing to install.
#
#   local/sql.sh                                    # a prompt (\q to leave)
#   local/sql.sh -c "SELECT * FROM login_failures"  # one statement
#   local/sql.sh < sql/local/02_login_failures.sql  # a file
#
# It runs psql in a container on the streaming stack's network, so the stack
# has to be up: docker compose -f local/compose.yaml up -d --wait
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# With a file or a pipe on stdin there is no terminal to attach.
tty=()
[ -t 0 ] || tty=(-T)
exec docker compose --progress quiet --project-name "$STREAMING_PROJECT" -f "$LOCAL_DIR/compose.yaml" \
  run --rm ${tty[@]+"${tty[@]}"} psql "$@"
