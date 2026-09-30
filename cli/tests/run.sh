#!/usr/bin/env bash
# Tests for the CLI path, run against tests/fake-ork (no network, no real ork).
#
#   cli/tests/run.sh
#
# Each test copies cli/ and agent/ into a throwaway repo, writes a team card,
# scripts what the agent does, runs a layer script, and checks what it printed
# and exactly which ork commands it ran.
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
CLI=$(dirname "$TESTS")
REPO=$(dirname "$CLI")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/hello-cli-tests.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
ln -s "$TESTS/fake-ork" "$WORK/bin/ork"
export PATH="$WORK/bin:$PATH"
# Nothing from the developer's own shell may leak into the tests.
unset SN_API_KEY SN_SERVICE_ACCOUNT ORCA_BASE_URL KAFKA_BOOTSTRAP_SERVERS SCHEMA_REGISTRY_URL SN_MCP_URL \
  LOGIN_TOPIC ORCA_MODEL PARTICIPANT ORCA_API_KEY ORCA_ACCESS_TOKEN ORCA_REGISTRY_URL
export HELLO_ROUND_SECONDS=1 HELLO_TURN_TIMEOUT=5

MCP_URL=https://mcp.example.com/mcp/x/o-test/sqlworkspace/ws-1
SHA_L1=457f86a77738415f
SHA_L3=ac4d0b08aca3f336
SHA_L4=452e3876c295ffc8

PASSED=0
FAILED=0
R=""
STATUS=0

# ------------------------------------------------------------------ helpers --

fresh_repo() {  # fresh_repo <name>
  R="$WORK/repo-$1"
  mkdir -p "$R/cli" "$R/agent"
  cp "$CLI"/*.sh "$CLI/pretty.jq" "$R/cli/"
  cp "$REPO"/agent/*.json "$R/agent/"
  export FAKE_ORK_DIR="$R/fake"
  mkdir -p "$FAKE_ORK_DIR/reactions"
  unset FAKE_ORK_BARE FAKE_ORK_NO_ECHO FAKE_ORK_TAKEN_ENVS FAKE_ORK_FAIL
}

card() {  # the team card, as a participant would paste it
  cat >"$R/.env" <<EOF
# team card
SN_API_KEY=test-key
SN_SERVICE_ACCOUNT=team-07@o-test.auth.streamnative.cloud
ORCA_BASE_URL=https://ws.example.com
SN_MCP_URL=$MCP_URL
ORCA_MODEL=claude-sonnet-4-6
PARTICIPANT=jane
EOF
}

reaction() {  # reaction <n> <event json>...  (what the agent emits after the n-th send)
  printf '%s\n' "${@:2}" >"$FAKE_ORK_DIR/reactions/$1.ndjson"
}

message() { printf '{"id":"%s","type":"agent.message","content":[{"type":"text","text":"%s"}]}' "$1" "$2"; }

# Event ids are unique within a session, so every idle event gets its own.
end_turn() { printf '{"id":"evt_idle_%s","type":"session.status_idle","stop_reason":{"type":"end_turn"}}' "$1"; }

run() {  # run <stdin text> <script> [args...]
  local input=$1 script=$2
  shift 2
  if (cd "$R/cli" && printf '%s' "$input" | ./"$script" "$@") >"$R/out" 2>"$R/err"; then STATUS=0; else STATUS=$?; fi
}

called() {  # called <exact invocation as a JSON array>
  jq -e -s --argjson want "$1" 'any(. == $want)' "$FAKE_ORK_DIR/calls.log" >/dev/null
}

called_with() {  # called_with "<command words>" <argument>
  jq -e -s --arg cmd "$1" --arg arg "$2" \
    'any(($cmd | split(" ")) as $words | .[0:($words | length)] == $words and index([$arg]) != null)' \
    "$FAKE_ORK_DIR/calls.log" >/dev/null
}

calls_of() { jq -s --arg cmd "$1" '[.[] | select(join(" ") | startswith($cmd))] | length' "$FAKE_ORK_DIR/calls.log"; }

out_has() { grep -qF -- "$1" "$R/out"; }
err_has() { grep -qF -- "$1" "$R/err"; }
state_is() { [ "$(jq -r --arg k "$1" '.[$k] // empty' "$R/.orca-state/jane.json")" = "$2" ]; }

check() {  # check <description> <command...>
  if "${@:2}"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL  %s\n' "$1"
    printf -- '--- stdout\n'; cat "$R/out" 2>/dev/null || true
    printf -- '--- stderr\n'; cat "$R/err" 2>/dev/null || true
    printf -- '--- ork calls\n'; cat "$FAKE_ORK_DIR/calls.log" 2>/dev/null || true
  fi
}

# -------------------------------------------------------------------- tests --

test_missing_team_card() {
  fresh_repo missing
  run "" l1_hello.sh
  check "exits 1 without a team card" [ "$STATUS" -eq 1 ]
  check "names every missing variable" \
    err_has "Missing ORCA_BASE_URL, ORCA_MODEL, SN_API_KEY. Copy .env.example to .env in the repo root and fill it in from your team card."
  check "runs no ork command" [ ! -s "$FAKE_ORK_DIR/calls.log" ]
}

test_l1_creates_everything() {
  fresh_repo l1
  card
  reaction 1 "$(message evt_a 'Hello!')" "$(end_turn 1)"
  run "" l1_hello.sh
  check "L1 succeeds" [ "$STATUS" -eq 0 ]
  check "hosted team cards use only Bearer" jq -e '.access_token_set and (.api_key_set | not)' "$FAKE_ORK_DIR/auth.json"
  check "creates the environment" called '["agent","environments","create","--name","hello-env-jane","-o","json"]'
  check "creates the agent with the L1 fingerprint" called_with "agent create" "definition_sha=$SHA_L1"
  check "names the agent after the participant" called_with "agent create" "hello-agent-jane"
  check "sends no tools or MCP servers" [ "$(jq -s '[.[] | select(.[0:2] == ["agent","create"]) | index(["--tool-json"], ["--mcp-server"]) | select(. != null)] | length' "$FAKE_ORK_DIR/calls.log")" -eq 0 ]
  check "pins the session to the agent version" \
    called '["agent","sessions","create","--agent","agent_1","--agent-version","1","--environment-id","env_1","--title","L1: hello","-o","json"]'
  check "prints the version line" out_has "hello-agent-jane v1: no tools: just a conversation"
  check "prints the question" out_has "[you]    Hi! What is the Data + Agent Hackathon, and what can you see right now?"
  check "prints the reply" out_has "[agent]  Hello!"
  check "remembers the agent" state_is agent_id agent_1
  check "remembers the environment" state_is environment_id env_1

  # Run it again: same definition, so nothing is created or updated.
  reaction 2 "$(message evt_b 'Hello again!')" "$(end_turn 2)"
  run "" l1_hello.sh "Is anyone there?"
  check "rerun succeeds" [ "$STATUS" -eq 0 ]
  check "rerun creates no second agent" [ "$(calls_of "agent create")" -eq 1 ]
  check "rerun does not update the agent" [ "$(calls_of "agent update")" -eq 0 ]
  check "rerun reuses the environment" [ "$(calls_of "agent environments create")" -eq 1 ]
  check "takes the question from the arguments" out_has "[you]    Is anyone there?"
  check "rerun stays on version 1" out_has "hello-agent-jane v1:"

  # L3: the same agent moves to its next version, with a vault for the MCP credential.
  reaction 3 \
    '{"id":"evt_q","type":"agent.mcp_tool_use","name":"sql_workspace_query","mcp_server_name":"streamnative","input":{"sql":"SELECT * FROM login_failures"}}' \
    '{"id":"evt_r","type":"agent.mcp_tool_result","mcp_tool_use_id":"evt_q","is_error":false,"content":[{"type":"text","text":"3 rows: acct_0042 failed=5"}]}' \
    "$(message evt_c 'acct_0042 looks taken over.')" "$(end_turn 3)"
  reaction 4 "$(message evt_d 'Now acct_9123 too.')" "$(end_turn 4)"
  run $'and now?\n' l3_live_context.sh
  check "L3 succeeds" [ "$STATUS" -eq 0 ]
  check "updates the same agent from version 1" called_with "agent update agent_1" "--version"
  check "update carries the L3 fingerprint" called_with "agent update agent_1" "definition_sha=$SHA_L3"
  check "update attaches the MCP server" called_with "agent update agent_1" "name=streamnative,type=url,url=$MCP_URL"
  check "creates the vault" called '["agent","vaults","create","--display-name","hello-vault-jane","-o","json"]'
  check "stores a bearer credential for the MCP server" \
    called "$(jq -cn --arg url "$MCP_URL" '["agent","vaults","credentials","create","--vault","vlt_1","--display-name","streamnative-mcp","--auth-json",({type:"static_bearer",mcp_server_url:$url,token:"test-key"} | tojson),"-o","json"]')"
  check "gives the session the vault" called_with "agent sessions create" "vlt_1"
  check "prints the new version" out_has "hello-agent-jane v2: + StreamNative MCP (read-only SQL tools)"
  check "shows the tool call" out_has '[tool]   sql_workspace_query {"sql": "SELECT * FROM login_failures"}'
  check "shows the tool result" out_has "[result] 3 rows: acct_0042 failed=5"
  check "prints the first answer once" [ "$(grep -cF 'acct_0042 looks taken over.' "$R/out")" -eq 1 ]
  check "asks again" out_has "Ask again (Enter to quit): "
  check "answers the follow-up" out_has "[agent]  Now acct_9123 too."
  check "resumes the stream from the last frame" \
    [ "$(jq -s '[.[] | select(.[0:4] == ["agent","sessions","events","stream"]) | .[(index("--from-cursor") + 1)] | tonumber] | max' "$FAKE_ORK_DIR/calls.log")" -gt 0 ]

  # Back to L1: ork cannot take tools away, so a fresh agent replaces the old one.
  reaction 5 "$(message evt_e 'Back to basics.')" "$(end_turn 5)"
  run "" l1_hello.sh
  check "going back to L1 succeeds" [ "$STATUS" -eq 0 ]
  check "archives the agent that has tools" called '["agent","archive","agent_1"]'
  check "creates a fresh L1 agent" [ "$(calls_of "agent create")" -eq 2 ]
  check "remembers the fresh agent" state_is agent_id agent_2
  check "explains why" err_has "ork cannot remove tools from an agent"

  # Cleanup removes everything and forgets the ids.
  run "" cleanup.sh
  check "cleanup succeeds" [ "$STATUS" -eq 0 ]
  check "archives the agent" out_has "removed agent agent_2"
  check "deletes the vault" out_has "removed vault vlt_1"
  check "archives the environment" out_has "removed environment env_1"
  check "forgets the ids" [ ! -f "$R/.orca-state/jane.json" ]
}

test_turns_ignore_history_and_duplicates() {
  fresh_repo replay
  card
  cat >"$FAKE_ORK_DIR/history.ndjson" <<'EOF'
{"id":"evt_old_msg","type":"agent.message","processed_at":"2026-10-07T09:59:01.000Z","content":[{"type":"text","text":"old answer"}]}
{"id":"evt_old_idle","type":"session.status_idle","processed_at":"2026-10-07T09:59:02.000Z","stop_reason":{"type":"end_turn"}}
EOF
  reaction 1 "$(message evt_new 'new answer')" "$(message evt_new 'new answer')" "$(end_turn 6)"
  run "" l1_hello.sh
  check "succeeds despite a replayed transcript" [ "$STATUS" -eq 0 ]
  check "skips the earlier turn" bash -c "! grep -qF 'old answer' '$R/out'"
  check "prints a repeated event once" [ "$(grep -cF 'new answer' "$R/out")" -eq 1 ]
}

test_bare_stream_lines() {
  fresh_repo bare
  card
  export FAKE_ORK_BARE=1 FAKE_ORK_NO_ECHO=1
  reaction 1 "$(message evt_a 'bare hello')" "$(end_turn 7)"
  run "" l1_hello.sh
  check "handles stream lines without the SSE wrapper" [ "$STATUS" -eq 0 ]
  check "prints them" out_has "[agent]  bare hello"
}

test_l4_approval() {
  local tool_use='{"id":"evt_tool_1","type":"agent.mcp_tool_use","name":"sql_workspace_insert_rows","mcp_server_name":"streamnative","input":{"table":"flagged_accounts","rows":[{"account_id":"acct_9123"}]}}'
  local blocked='{"id":"evt_idle_ask","type":"session.status_idle","stop_reason":{"type":"requires_action","event_ids":["evt_tool_1"]}}'

  fresh_repo allow
  card
  reaction 1 "$tool_use" "$blocked"
  reaction 2 "$(message evt_done 'Flagged acct_9123.')" "$(end_turn 8)"
  run $'y\n' l4_act.sh
  check "L4 allow succeeds" [ "$STATUS" -eq 0 ]
  check "creates the agent with the L4 fingerprint" called_with "agent create" "definition_sha=$SHA_L4"
  check "shows what the agent wants to run" out_has "[approve?] The agent wants to run sql_workspace_insert_rows with:"
  check "shows the input" out_has '"account_id": "acct_9123"'
  check "sends allow for the blocked tool" \
    called '["agent","sessions","events","send","tool-confirmation","--session","sess_1","--tool-use-id","evt_tool_1","--decision","allow","-o","json"]'
  check "continues after the approval" out_has "[agent]  Flagged acct_9123."

  fresh_repo deny
  card
  reaction 1 "$tool_use" "$blocked"
  reaction 2 "$(message evt_ack 'Understood, not flagged.')" "$(end_turn 9)"
  run $'n\n' l4_act.sh
  check "L4 deny succeeds" [ "$STATUS" -eq 0 ]
  check "sends deny with the reason" \
    called '["agent","sessions","events","send","tool-confirmation","--session","sess_1","--tool-use-id","evt_tool_1","--decision","deny","--deny-message","The human reviewer denied this action.","-o","json"]'
  check "continues after the denial" out_has "[agent]  Understood, not flagged."

  fresh_repo no-approver
  card
  reaction 1 "$tool_use" "$blocked"
  run "" l3_live_context.sh
  check "an approval request without an approver fails" [ "$STATUS" -eq 1 ]
  check "says why" err_has "The agent is waiting for human approval, but this script has no approver."
}

test_errors() {
  fresh_repo retrying
  card
  reaction 1 \
    '{"id":"evt_err","type":"session.error","error":{"type":"overloaded_error","message":"model busy"},"retry_status":{"will_retry":true}}' \
    "$(message evt_ok ok)" "$(end_turn 10)"
  run "" l1_hello.sh
  check "a retrying error is not fatal" [ "$STATUS" -eq 0 ]
  check "but it is shown" out_has "[error]  model busy (retrying)"

  fresh_repo exhausted
  card
  reaction 1 \
    '{"id":"evt_err","type":"session.error","error":{"type":"invalid_request_error","message":"model not found: nope-1"},"retry_status":{"will_retry":false}}' \
    '{"id":"evt_idle_x","type":"session.status_idle","stop_reason":{"type":"retries_exhausted"}}'
  run "" l1_hello.sh
  check "retries_exhausted exits 1" [ "$STATUS" -eq 1 ]
  check "with the last error" err_has "The agent stopped (retries_exhausted): model not found: nope-1"

  fresh_repo stalled
  card
  export HELLO_TURN_TIMEOUT=2
  reaction 1 "$(message evt_p partial)"
  run "" l1_hello.sh
  export HELLO_TURN_TIMEOUT=5
  check "a turn that never ends times out" [ "$STATUS" -eq 1 ]
  check "and says so" err_has "The agent did not finish its turn within 2s."

  fresh_repo unauthorized
  card
  export FAKE_ORK_FAIL="agent environments create:401"
  run "" l1_hello.sh
  check "an ork failure exits 1" [ "$STATUS" -eq 1 ]
  check "shows ork's message and the doctor hint" err_has "returned status 401"
  check "points at the doctor" err_has "doctor"
}

retried_with_suffix() {
  jq -e -s '[.[] | select(.[0:3] == ["agent","environments","create"]) | .[4]] | .[1] | test("^hello-env-jane-[0-9a-f]{4}$")' \
    "$FAKE_ORK_DIR/calls.log" >/dev/null
}

test_environment_name_taken() {
  fresh_repo taken
  card
  export FAKE_ORK_TAKEN_ENVS=hello-env-jane
  reaction 1 "$(message evt_a hi)" "$(end_turn 11)"
  run "" l1_hello.sh
  check "a reserved environment name is not fatal" [ "$STATUS" -eq 0 ]
  check "retries with a suffix" retried_with_suffix
}

test_cleanup_tolerates_missing_resources() {
  fresh_repo gone
  card
  mkdir -p "$R/.orca-state"
  echo '{"agent_id":"agent_gone","environment_id":"env_gone","vault_id":"vlt_gone"}' >"$R/.orca-state/jane.json"
  run "" cleanup.sh
  check "cleanup succeeds" [ "$STATUS" -eq 0 ]
  check "reports the agent as gone" out_has "agent agent_gone was already gone"
  check "reports the vault as gone" out_has "vault vlt_gone was already gone"
  check "reports the environment as gone" out_has "environment env_gone was already gone"
  check "forgets the ids" [ ! -f "$R/.orca-state/jane.json" ]
}

test_team_card_parsing() {
  fresh_repo parsing
  printf '%s\r\n' \
    '# comment line' \
    'export SN_API_KEY="quoted-key"' \
    "ORCA_BASE_URL = 'https://ws.example.com'" \
    'ORCA_MODEL=claude-sonnet-4-6  # inline comment' \
    'PARTICIPANT=Jane.Doe_42' \
    'not a variable line' >"$R/.env"
  reaction 1 "$(message evt_a hi)" "$(end_turn 12)"
  export ORCA_MODEL=exported-model
  run "" l1_hello.sh
  unset ORCA_MODEL
  check "parses quotes, export, comments, and CRLF" [ "$STATUS" -eq 0 ]
  check "an exported variable wins over .env" called_with "agent create" "exported-model"
  check "the participant name is made safe" called_with "agent create" "hello-agent-jane-doe-42"
  check "state goes to the participant's file" [ -f "$R/.orca-state/jane-doe-42.json" ]
}

test_local_registry_key() {
  fresh_repo local-key
  cat >"$R/.env" <<EOF
ORCA_BASE_URL=http://127.0.0.1:8080
ORCA_API_KEY=local-test-key
ORCA_MODEL=claude-sonnet-4-6
PARTICIPANT=jane
EOF
  export ORCA_ACCESS_TOKEN=stale-bearer
  reaction 1 "$(message evt_a 'Hello locally!')" "$(end_turn local)"
  run "" l1_hello.sh
  unset ORCA_ACCESS_TOKEN
  check "local L1 needs no team-card key" [ "$STATUS" -eq 0 ]
  check "local key uses only x-api-key" jq -e '.api_key_set and (.access_token_set | not)' "$FAKE_ORK_DIR/auth.json"
}

test_local_registry_key
test_missing_team_card
test_l1_creates_everything
test_turns_ignore_history_and_duplicates
test_bare_stream_lines
test_l4_approval
test_errors
test_environment_name_taken
test_cleanup_tolerates_missing_resources
test_team_card_parsing

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
