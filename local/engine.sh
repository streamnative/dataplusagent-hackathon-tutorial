#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Start the Agent Engine for the Local course, and let it reach your MCP server.
#
#   export ANTHROPIC_API_KEY=...   # the engine reads your provider key when it starts
#   local/engine.sh                # start (or restart) the engine, then link it
#   local/engine.sh --check        # only check the link
#
# What it runs, in order:
#
#   1. ork local --data-dir <this checkout>/.lab/ork start --with-gateway
#      The Agent Engine, with the AI Gateway. The gateway makes every MCP call on
#      your agent's behalf, so MCP tools need it. The data directory is given as a
#      full path: ork v0.6.0 does not resolve a relative one. First, the engine's
#      containers that are not running are removed, so that it starts from fresh
#      ones. Its data is in volumes.
#
#   2. The link. The gateway refuses private MCP hosts unless they are on its
#      allowlist, and `ork local start` writes that allowlist empty every time.
#      So this script adds one host (risingwave-mcp) to .lab/ork/gateway.yaml,
#      restarts the gateway, and attaches the MCP server's container to the
#      engine's Docker network under that name.
#
# Safe to run again at any time. Run it again after anything restarts the engine.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

FAILED=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() {  # fail <what> <fix>
  printf 'FAIL  %s\n      fix: %s\n' "$1" "$2"
  FAILED=$((FAILED + 1))
}

# Run curl in a throwaway container on the engine's network: what the gateway sees.
curl_on() {  # curl_on <network> <curl args...>
  docker run --rm --network "$1" --entrypoint curl "$CURL_IMAGE" "${@:2}"
}

start_engine() {
  command -v ork >/dev/null || die "ork (the Orca CLI) is not installed. See labs/local/00-set-up.md."
  [ -n "${ANTHROPIC_API_KEY:-}" ] ||
    die "ANTHROPIC_API_KEY is not set in this shell. The engine reads it when it starts:
  export ANTHROPIC_API_KEY=<your key>"
  [ -n "$(mcp_container)" ] ||
    die "The streaming stack is not running. Start it first:
  docker compose -f local/compose.yaml up -d --wait"
  # Replace what is not running. A container whose port could not be bound
  # (another program had it) stays cut off from its network: Docker starts it
  # with loopback only from then on, even once the port is free (seen with
  # Docker Engine 29.2). The engine's data is in volumes, so nothing is lost.
  local name
  while IFS= read -r name; do
    [ -z "$name" ] || docker rm "$name" >/dev/null
  done < <(engine_stopped_containers)
  ork local --data-dir "$ORK_DIR" start --with-gateway
}

link() {
  local gateway network mcp
  gateway=$(engine_container ai-gateway)
  mcp=$(mcp_container)
  [ -n "$gateway" ] || die "The AI Gateway is not running: \`ork local start --with-gateway\` did not start it."

  allow_mcp_host "$ORK_DIR/gateway.yaml"
  # The gateway reads its config when it starts. A restart keeps its environment,
  # so your provider key stays in place.
  docker restart "$gateway" >/dev/null

  network=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$gateway")
  if ! docker network inspect "$network" -f '{{range .Containers}}{{.Name}} {{end}}' | grep -qw -- "$mcp"; then
    docker network connect --alias "$MCP_HOST" "$network" "$mcp"
  fi

  # Wait until the gateway answers again.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl_on "$network" -s -o /dev/null --max-time 3 http://ai-gateway:8090/; then return 0; fi
    sleep 1
  done
  die "The AI Gateway did not come back after its restart. Look at: docker logs $gateway"
}

check() {
  local gateway network mcp
  gateway=$(engine_container ai-gateway)
  mcp=$(mcp_container)

  if [ -z "$gateway" ]; then
    fail "the AI Gateway is running" "local/engine.sh"
    return
  fi
  pass "the AI Gateway is running"

  if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$gateway" | grep -q '^ANTHROPIC_API_KEY=.'; then
    pass "the gateway has a provider key"
  else
    fail "the gateway has a provider key" "export ANTHROPIC_API_KEY=<your key>, then local/engine.sh"
  fi

  if grep -qF "allowed_private_hosts: ['$MCP_HOST']" "$ORK_DIR/gateway.yaml" 2>/dev/null; then
    pass "the gateway allows the MCP host $MCP_HOST"
  else
    fail "the gateway allows the MCP host $MCP_HOST" "local/engine.sh"
  fi

  if [ -z "$mcp" ]; then
    fail "the MCP server is running" "docker compose -f local/compose.yaml up -d --wait, then local/engine.sh"
    return
  fi
  network=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$gateway")
  # The request the gateway will make: an MCP initialize, by the allowlisted name.
  if curl_on "$network" -fsS -o /dev/null --max-time 10 -X POST "http://$MCP_HOST:8000/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"engine-check","version":"1"}}}' 2>/dev/null; then
    pass "the MCP server answers at http://$MCP_HOST:8000/mcp on the engine's network"
  else
    fail "the MCP server answers at http://$MCP_HOST:8000/mcp on the engine's network" "local/engine.sh"
  fi
}

command -v docker >/dev/null || die "docker is not installed. The Local course runs in Docker."

case "${1:-}" in
  "")
    start_engine
    link
    ;;
  --check) ;;
  *) die "usage: local/engine.sh [--check]" ;;
esac

check
if [ "$FAILED" -eq 0 ]; then
  printf '\nThe Agent Engine is up and can reach your MCP server.\n'
else
  printf '\n%d check(s) failed.\n' "$FAILED"
  exit 1
fi
