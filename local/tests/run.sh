#!/usr/bin/env bash
# Tests for the Local course's helper scripts: the file logic, with no Docker.
#
#   local/tests/run.sh
#
# What needs a running stack (starting the engine, linking the MCP server,
# stopping) is proven by walking the Local course itself.
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
LOCAL=$(dirname "$TESTS")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/hello-local-tests.XXXXXX")
WORK=$(cd "$WORK" && pwd)   # as the scripts see it: a TMPDIR ending in "/" leaves a "//"
trap 'rm -rf "$WORK"' EXIT

# A `docker` that knows which host port the registry is published on, which
# containers exist, and remembers what it was asked.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
[ -n "${FAKE_DOCKER_DIR:-}" ] || exit 1
printf '%s\n' "$*" >>"$FAKE_DOCKER_DIR/calls"
case "$1" in
  ps)
    case " $* " in
      *" -a "*)
        # Every container, running or not: the "<status> <name>" lines of the
        # fixture, when the question is narrowed to the engine's project. A
        # status filter keeps the lines with that status.
        if [[ " $* " != *" label=com.docker.compose.project.working_dir=${FAKE_DOCKER_DIR%/*}/.lab/ork "* ]]; then
          echo someone-elses-container
        elif [ -f "$FAKE_DOCKER_DIR/containers" ]; then
          while read -r status name; do
            [[ " $* " == *" status="* && " $* " != *" status=$status "* ]] || echo "$name"
          done <"$FAKE_DOCKER_DIR/containers"
        fi
        ;;
      *) [ -f "$FAKE_DOCKER_DIR/registry-port" ] && echo registry-1 ;;
    esac
    ;;
  port)
    [ ! -f "$FAKE_DOCKER_DIR/port-fails" ] || exit 1
    [ -f "$FAKE_DOCKER_DIR/registry-port" ] && echo "127.0.0.1:$(cat "$FAKE_DOCKER_DIR/registry-port")"
    ;;
  rm) [ $# -ge 2 ] || exit 1 ;;   # like docker, it wants at least one container
  compose) ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$WORK/bin/docker"
# An `ork` that remembers the call and stops the script there: what comes after
# a start needs a running stack.
cat >"$WORK/bin/ork" <<'EOF'
#!/usr/bin/env bash
[ -n "${FAKE_DOCKER_DIR:-}" ] || exit 1
printf 'ork %s\n' "$*" >>"$FAKE_DOCKER_DIR/calls"
exit 1
EOF
chmod +x "$WORK/bin/ork"
export PATH="$WORK/bin:$PATH"
# Nothing from the developer's own shell may leak into the tests.
unset ORCA_LOCAL_REGISTRY_PORT TUTORIAL_STACK PARTICIPANT ORCA_MODEL ORCA_API_KEY

PASSED=0
FAILED=0
R=""
STATUS=0
KEY=orca_test_key_0123456789

# ------------------------------------------------------------------ helpers --

fresh_repo() {  # fresh_repo <name>: a throwaway repo holding a copy of local/
  R="$WORK/repo-$1"
  mkdir -p "$R/local"
  cp "$LOCAL"/*.sh "$R/local/"
  export FAKE_DOCKER_DIR="$R/fake-docker"
  mkdir -p "$FAKE_DOCKER_DIR"
}

engine_started() {  # what `ork local start` leaves behind, on host port <port>
  mkdir -p "$R/.lab/ork/secrets"
  printf '%s' "$KEY" >"$R/.lab/ork/secrets/workspace-api-key"
  printf '%s' "${1:-8080}" >"$FAKE_DOCKER_DIR/registry-port"
}

run() {  # run <script> [args...]
  if (cd "$R" && "local/$1" "${@:2}") >"$R/out" 2>"$R/err"; then STATUS=0; else STATUS=$?; fi
}

env_is() { [ "$(sed -n "s/^$1=//p" "$R/.env")" = "$2" ]; }
out_has() { grep -qF -- "$1" "$R/out"; }
err_has() { grep -qF -- "$1" "$R/err"; }
not() { ! "$@"; }

check() {  # check <description> <command...>
  if "${@:2}"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL  %s\n' "$1"
    printf -- '--- stdout\n'; cat "$R/out" 2>/dev/null || true
    printf -- '--- stderr\n'; cat "$R/err" 2>/dev/null || true
    printf -- '--- .env\n'; sed 's/^ORCA_API_KEY=.*/ORCA_API_KEY=<hidden>/' "$R/.env" 2>/dev/null || true
  fi
}

# --------------------------------------------------------------- write-env --

test_write_env_before_the_engine_started() {
  fresh_repo no-engine
  run write-env.sh
  check "exits 1 when the engine has no key yet" [ "$STATUS" -eq 1 ]
  check "says to start the engine first" err_has "local/engine.sh"
  check "writes no .env" [ ! -e "$R/.env" ]
}

test_write_env_writes_the_local_contract() {
  fresh_repo contract
  engine_started 8080
  run write-env.sh
  check "succeeds" [ "$STATUS" -eq 0 ]
  check "marks the stack as local" env_is TUTORIAL_STACK local
  check "copies the workspace key" env_is ORCA_API_KEY "$KEY"
  check "points at the local registry" env_is ORCA_BASE_URL http://127.0.0.1:8080
  check "points at the local broker" env_is KAFKA_BOOTSTRAP_SERVERS 127.0.0.1:29092
  check "points at the local schema registry" env_is SCHEMA_REGISTRY_URL http://127.0.0.1:18081
  check "gives the agent the MCP address the gateway uses" env_is RW_MCP_URL http://risingwave-mcp:8000/mcp
  check "gives the doctor the MCP address your terminal uses" env_is RW_MCP_LOCAL_URL http://127.0.0.1:8000/mcp
  check "names the login topic" env_is LOGIN_TOPIC security.login_events
  check "picks a default model" env_is ORCA_MODEL claude-sonnet-4-6
  check "leaves the participant to default to your user name" env_is PARTICIPANT ""
  # GNU stat first: its -f means something else, and prints before it fails.
  check "keeps .env private to you" [ "$(stat -c %a "$R/.env" 2>/dev/null || stat -f %Lp "$R/.env")" = 600 ]
  check "never prints the key" [ "$(grep -c "$KEY" "$R/out" "$R/err" | awk -F: '{s += $2} END {print s}')" -eq 0 ]
}

test_write_env_reads_the_port_the_registry_is_published_on() {
  fresh_repo port
  engine_started 18080
  run write-env.sh
  check "uses the published port, whatever your shell says" env_is ORCA_BASE_URL http://127.0.0.1:18080
}

test_write_env_falls_back_to_the_port_in_your_shell() {
  fresh_repo port-fallback
  engine_started
  rm "$FAKE_DOCKER_DIR/registry-port"   # the registry is not running
  ORCA_LOCAL_REGISTRY_PORT=19090 run write-env.sh
  check "uses ORCA_LOCAL_REGISTRY_PORT when the registry is not running" env_is ORCA_BASE_URL http://127.0.0.1:19090
}

test_write_env_survives_a_registry_whose_port_docker_cannot_tell() {
  fresh_repo port-unknown
  engine_started 8080
  touch "$FAKE_DOCKER_DIR/port-fails"   # the container is listed, but `docker port` fails
  ORCA_LOCAL_REGISTRY_PORT=19090 run write-env.sh
  check "still writes .env when docker cannot tell the port" [ "$STATUS" -eq 0 ]
  check "and falls back to the port in your shell" env_is ORCA_BASE_URL http://127.0.0.1:19090
}

test_the_streaming_stack_is_always_named_by_this_repo() {
  # An exported COMPOSE_PROJECT_NAME beats the name in the Compose file. Without
  # the flag, `local/down.sh --reset` would delete another project's volumes.
  fresh_repo project-name
  cat >"$R/local/streaming-down.sh" <<'EOF'
#!/usr/bin/env bash
. "$(dirname "$0")/lib.sh"
streaming down -v --remove-orphans
EOF
  chmod +x "$R/local/streaming-down.sh"
  COMPOSE_PROJECT_NAME=someone-elses-app run streaming-down.sh
  check "docker compose is told the project by name" \
    grep -q -- "^compose .*--project-name hello-data-agent .*down -v --remove-orphans$" "$FAKE_DOCKER_DIR/calls"
}

test_write_env_never_overwrites_a_team_card() {
  fresh_repo team-card
  engine_started
  printf 'SN_API_KEY=team-key\nORCA_BASE_URL=https://ws.example.com\n' >"$R/.env"
  run write-env.sh
  check "exits 1 on a cloud .env" [ "$STATUS" -eq 1 ]
  check "leaves the team card as it was" env_is SN_API_KEY team-key
  check "says how to keep both" err_has "mv .env .env.cloud"
}

test_write_env_refreshes_a_local_env_and_keeps_your_choices() {
  fresh_repo refresh
  engine_started 8080
  printf 'TUTORIAL_STACK=local\nORCA_API_KEY=orca_old_key\nORCA_MODEL=claude-haiku-4-5\nPARTICIPANT=ana\n' >"$R/.env"
  run write-env.sh
  check "succeeds on a local .env" [ "$STATUS" -eq 0 ]
  check "replaces the old key" env_is ORCA_API_KEY "$KEY"
  check "keeps your participant name" env_is PARTICIPANT ana
  check "keeps your model" env_is ORCA_MODEL claude-haiku-4-5
}

# ----------------------------------------------------- starting the engine --

start_engine() {  # local/engine.sh, as far as `ork local start`
  ANTHROPIC_API_KEY=not-a-real-key run engine.sh
}

started() { grep -qE '^ork local .* start --with-gateway$' "$FAKE_DOCKER_DIR/calls"; }
removed() { grep -qE "^rm( .*)? $1( |\$)" "$FAKE_DOCKER_DIR/calls"; }
removed_before_the_start() {  # removed_before_the_start <container>
  sed '/^ork /,$d' "$FAKE_DOCKER_DIR/calls" | grep -qE "^rm( .*)? $1( |\$)"
}

test_engine_replaces_its_containers_that_are_not_running() {
  # A container whose port could not be bound comes back without its network,
  # even once the port is free (Docker Engine 29.2). A start must not reuse it.
  fresh_repo engine-stopped
  engine_started
  printf '%s\n' 'created ork-registry-1' 'exited ork-migrate-1' 'running ork-harness-1' >"$FAKE_DOCKER_DIR/containers"
  start_engine
  check "removes a container that never started, before the engine starts" removed_before_the_start ork-registry-1
  check "removes a container that has stopped, before the engine starts" removed_before_the_start ork-migrate-1
  check "leaves a running container alone" not removed ork-harness-1
  check "leaves other projects' containers alone" not removed someone-elses-container
  check "then starts the engine" started
}

test_engine_starts_when_nothing_has_stopped() {
  fresh_repo engine-running
  engine_started
  printf '%s\n' 'running ork-registry-1' >"$FAKE_DOCKER_DIR/containers"
  start_engine
  check "asks docker to remove nothing" not grep -q '^rm' "$FAKE_DOCKER_DIR/calls"
  check "and starts the engine" started
}

# ------------------------------------------------------- the gateway patch --

gateway_yaml() {  # the two lines of `ork local`'s gateway.yaml that matter here
  printf "      egress_policy:\n        allowed_private_hosts: %s\n        dns_timeout_ms: 2000\n" "$1" >"$R/gateway.yaml"
}

patch() {  # run allow_mcp_host from local/lib.sh on the fixture
  if (cd "$R" && . local/lib.sh && allow_mcp_host "$R/gateway.yaml") >"$R/out" 2>"$R/err"; then STATUS=0; else STATUS=$?; fi
}

test_the_gateway_is_told_to_allow_the_mcp_host() {
  fresh_repo patch
  gateway_yaml "[]"
  patch
  check "patching succeeds" [ "$STATUS" -eq 0 ]
  check "the MCP host is allowlisted" grep -qF "allowed_private_hosts: ['risingwave-mcp']" "$R/gateway.yaml"
  check "the rest of the file is untouched" grep -qF "dns_timeout_ms: 2000" "$R/gateway.yaml"
}

test_patching_twice_changes_nothing() {
  fresh_repo patch-twice
  gateway_yaml "['risingwave-mcp']"
  cp "$R/gateway.yaml" "$R/before"
  patch
  check "an already patched file is accepted" [ "$STATUS" -eq 0 ]
  check "and left as it is" cmp -s "$R/gateway.yaml" "$R/before"
}

test_an_unexpected_gateway_config_is_an_error() {
  fresh_repo patch-unknown
  gateway_yaml "['some-other-host']"
  cp "$R/gateway.yaml" "$R/before"
  patch
  check "an unknown allowlist stops the script" [ "$STATUS" -eq 1 ]
  check "the file is not modified" cmp -s "$R/gateway.yaml" "$R/before"
  check "the error says ork may have changed" err_has "ork"
}

# ---------------------------------------------------------------------- run --

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do "$t"; done

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
