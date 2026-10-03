#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Write .env for the Local course: where the stack on your laptop is, and the
# key `ork local` generated for its Agent Engine.
#
#   local/write-env.sh
#
# Run it again whenever local/engine.sh has started a fresh engine. It keeps your
# PARTICIPANT and ORCA_MODEL, and it never overwrites a team card.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

KEY_FILE="$ORK_DIR/secrets/workspace-api-key"
ENV_FILE="$REPO_ROOT/.env"

[ -s "$KEY_FILE" ] ||
  die "The Agent Engine has no key yet. Start it first: local/engine.sh"

participant=""
model=claude-sonnet-4-6
if [ -f "$ENV_FILE" ]; then
  [ "$(env_value TUTORIAL_STACK "$ENV_FILE")" = local ] ||
    die ".env holds a team card (the Cloud course), and this would replace it.
To keep it, move it aside first:  mv .env .env.cloud   (both names are git-ignored)"
  participant=$(env_value PARTICIPANT "$ENV_FILE")
  kept=$(env_value ORCA_MODEL "$ENV_FILE")
  [ -z "$kept" ] || model=$kept
fi

# The registry's host port: what Docker says while it runs, else what your shell says.
port=""
registry=$(engine_container registry 2>/dev/null || true)
[ -z "$registry" ] || port=$(docker port "$registry" 8080/tcp 2>/dev/null | sed -n 's/.*://p' | head -n 1) || true
[ -n "$port" ] || port=${ORCA_LOCAL_REGISTRY_PORT:-8080}

umask 077
cat >"$ENV_FILE.tmp" <<EOF
# Written by local/write-env.sh for the Local course. .env is git-ignored: never commit it.
TUTORIAL_STACK=local

# The Agent Engine that \`ork local\` runs, and the workspace key it generated.
ORCA_BASE_URL=http://127.0.0.1:$port
ORCA_API_KEY=$(cat "$KEY_FILE")

# Ursa for Kafka and its schema registry, as your terminal reaches them.
KAFKA_BOOTSTRAP_SERVERS=127.0.0.1:29092
SCHEMA_REGISTRY_URL=http://127.0.0.1:18081

# RisingWave's MCP server. The first address is the one your agent's definition
# carries: the AI Gateway reaches the server by that name. The second is the same
# server from your terminal, for the doctor.
RW_MCP_URL=http://$MCP_HOST:8000/mcp
RW_MCP_LOCAL_URL=http://127.0.0.1:8000/mcp

# The Kafka topic the injector writes to and RisingWave reads.
LOGIN_TOPIC=security.login_events

# The model your agent runs on. Your provider key must be able to use it.
ORCA_MODEL=$model

# Names your agent and environment. Defaults to your OS user name.
PARTICIPANT=$participant
EOF
mv "$ENV_FILE.tmp" "$ENV_FILE"
echo "Wrote .env for the local stack (Agent Engine at http://127.0.0.1:$port)."
