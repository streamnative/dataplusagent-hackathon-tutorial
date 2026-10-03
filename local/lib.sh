# shellcheck shell=bash
# Shared by the Local course's helper scripts. Sourced by them, never run directly.

LOCAL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$LOCAL_DIR/.." && pwd)
# Where `ork local` keeps the Agent Engine's config and keys. Inside the checkout,
# so each checkout has its own engine and nothing lands in your home directory.
ORK_DIR="$REPO_ROOT/.lab/ork"
# The name the AI Gateway reaches the MCP server by, on the engine's Docker network.
MCP_HOST=risingwave-mcp
# The object store's image ships a curl. Both stacks already use the image.
# shellcheck disable=SC2034  # read by engine.sh
CURL_IMAGE=rustfs/rustfs:1.0.0

die() {
  printf '\n%s\n' "$1" >&2
  exit 1
}

# The value of NAME in an env file: the last NAME=value line, quotes removed.
env_value() {  # env_value <name> <file>
  local value
  value=$(sed -n "s/^$1=//p" "$2" | tail -n 1)
  value=${value%$'\r'}
  case "$value" in
    \"*\") value=${value#\"} value=${value%\"} ;;
    \'*\') value=${value#\'} value=${value%\'} ;;
  esac
  printf '%s' "$value"
}

# The streaming stack's Compose project. Named on every call: an exported
# COMPOSE_PROJECT_NAME would otherwise beat the name in the Compose file, and
# `down -v` would then act on some other project.
STREAMING_PROJECT=hello-data-agent

streaming() {  # docker compose, for the streaming stack
  docker compose --progress quiet --project-name "$STREAMING_PROJECT" -f "$LOCAL_DIR/compose.yaml" "$@"
}

# The name of one of the Agent Engine's containers, if it is running.
engine_container() {  # engine_container <service>
  docker ps --filter "label=com.docker.compose.project.working_dir=$ORK_DIR" \
    --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -n 1
}

# The Agent Engine's containers that exist but are not running.
engine_stopped_containers() {
  docker ps -a --filter "label=com.docker.compose.project.working_dir=$ORK_DIR" \
    --filter status=created --filter status=exited --filter status=dead --format '{{.Names}}'
}

mcp_container() {
  docker ps --filter "label=com.docker.compose.project=$STREAMING_PROJECT" \
    --filter "label=com.docker.compose.service=risingwave-mcp" --format '{{.Names}}' | head -n 1
}

# `ork local` names its Compose project after a hash of the data directory.
engine_project() {
  local sum
  if command -v shasum >/dev/null; then
    sum=$(printf '%s' "$ORK_DIR" | shasum -a 256)
  else
    sum=$(printf '%s' "$ORK_DIR" | sha256sum)
  fi
  printf 'ork-local-%s' "${sum:0:8}"
}

# The AI Gateway makes every MCP call on the agent's behalf, and refuses private
# hosts unless they are allowlisted. `ork local start` writes the allowlist empty
# each time, so the one host the Local course needs is added here.
allow_mcp_host() {  # allow_mcp_host <gateway.yaml>
  local file=$1
  if grep -qF "allowed_private_hosts: ['$MCP_HOST']" "$file"; then
    return 0
  fi
  grep -qF 'allowed_private_hosts: []' "$file" ||
    die "Cannot find 'allowed_private_hosts: []' in $file.
This script was written for ork v0.6.0; your ork may write a different gateway config."
  sed "s/allowed_private_hosts: \[\]/allowed_private_hosts: ['$MCP_HOST']/" "$file" >"$file.tmp"
  # Keep the file itself, and its mode: the gateway container reads it.
  cat "$file.tmp" >"$file"
  rm -f "$file.tmp"
}
