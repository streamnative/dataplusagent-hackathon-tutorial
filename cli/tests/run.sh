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
  LOGIN_TOPIC ORCA_MODEL PARTICIPANT ORCA_API_KEY ORCA_ACCESS_TOKEN ORCA_REGISTRY_URL \
  SN_MCP_AUTH SN_MCP_OAUTH_ISSUER SN_MCP_OAUTH_SCOPE TUTORIAL_STACK RW_MCP_URL RW_MCP_LOCAL_URL
export HELLO_ROUND_SECONDS=1 HELLO_TURN_TIMEOUT=5

MCP_URL=https://mcp.example.com/mcp/x/o-test/sqlworkspace/ws-1
LOCAL_MCP_URL=http://risingwave-mcp:8000/mcp
# The same fingerprints the Python and TypeScript paths compute.
SHA_L1=457f86a77738415f
SHA_L3=ac4d0b08aca3f336
SHA_L4=8d424c704af22671
SHA_L3_LOCAL=bc4fde88405b950e
SHA_L4_LOCAL=db2876f6ae6d41f8

PASSED=0
FAILED=0
R=""
STATUS=0

# ------------------------------------------------------------------ helpers --

fresh_repo() {  # fresh_repo <name>
  R="$WORK/repo-$1"
  mkdir -p "$R/cli" "$R/agent"
  cp "$CLI"/*.sh "$CLI/pretty.jq" "$R/cli/"
  cp -R "$REPO/agent/cloud" "$REPO/agent/local" "$R/agent/"
  cp "$REPO/lab-ork" "$R/"
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
SN_MCP_AUTH=static_bearer
ORCA_MODEL=claude-sonnet-4-6
PARTICIPANT=jane
EOF
}

local_env() {  # what local/write-env.sh writes for the stack on your laptop
  cat >"$R/.env" <<EOF
TUTORIAL_STACK=local
ORCA_BASE_URL=http://127.0.0.1:8080
ORCA_API_KEY=local-test-key
RW_MCP_URL=$LOCAL_MCP_URL
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

lab_ork() {  # lab_ork <args...>: the check wrapper, from the repo root
  if (cd "$R" && ./lab-ork "$@") >"$R/out" 2>"$R/err"; then STATUS=0; else STATUS=$?; fi
}

json_is() {  # json_is <jq filter> <file>: the filter is true, and prints nothing
  jq -e "$1" "$2" >/dev/null
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
local_state_is() { [ "$(jq -r --arg k "$1" '.[$k] // empty' "$R/.orca-state/jane.local.json")" = "$2" ]; }

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
  check "names every missing variable, and both ways to get an .env" \
    err_has "Missing ORCA_BASE_URL, ORCA_MODEL, SN_API_KEY. Copy .env.cloud.example to .env in the repo root and fill it in from your StreamNative Cloud instance (Cloud course, Lab 0), or run local/write-env.sh for the Local course."
  check "runs no ork command" [ ! -s "$FAKE_ORK_DIR/calls.log" ]
}

test_l1_creates_everything() {
  fresh_repo l1
  card
  reaction 1 "$(message evt_a 'Hello!')" "$(end_turn 1)"
  run "" l1_hello.sh
  check "L1 succeeds" [ "$STATUS" -eq 0 ]
  check "hosted team cards use only Bearer" json_is '.access_token_set and (.api_key_set | not)' "$FAKE_ORK_DIR/auth.json"
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
  check "remembers the session, for your checks" state_is session_id sess_1

  # Run it again: same definition, so nothing is created or updated.
  reaction 2 "$(message evt_b 'Hello again!')" "$(end_turn 2)"
  run "" l1_hello.sh "Is anyone there?"
  check "rerun succeeds" [ "$STATUS" -eq 0 ]
  check "rerun creates no second agent" [ "$(calls_of "agent create")" -eq 1 ]
  check "rerun does not update the agent" [ "$(calls_of "agent update")" -eq 0 ]
  check "rerun reuses the environment" [ "$(calls_of "agent environments create")" -eq 1 ]
  check "takes the question from the arguments" out_has "[you]    Is anyone there?"
  check "rerun stays on version 1" out_has "hello-agent-jane v1:"
  check "remembers the newest session" state_is session_id sess_2

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

test_turns_on_an_engine_that_neither_stamps_nor_echoes_sent_events() {
  # The frame cursor is what keeps earlier turns out. A turn must not also need
  # the engine to put a time on our message, or to show it on the stream.
  fresh_repo unstamped
  card
  export FAKE_ORK_UNSTAMPED=1 FAKE_ORK_NO_ECHO=1
  reaction 1 "$(message evt_new 'the answer')" "$(end_turn 8)"
  run "" l1_hello.sh
  unset FAKE_ORK_UNSTAMPED FAKE_ORK_NO_ECHO
  check "a turn ends without a time on our message or an echo of it" [ "$STATUS" -eq 0 ]
  check "and prints the answer" out_has "the answer"
}

test_a_script_stopped_mid_turn_says_nothing_about_its_stream() {
  # The labs tell you to press Ctrl-C when the model does not answer. Stopping
  # the script stops the stream it was following; the shell must not report that.
  local pid tries=0
  fresh_repo interrupt
  card
  export FAKE_ORK_HANG=1   # the stream stays open, as it does while the agent is thinking
  (cd "$R/cli" && exec ./l1_hello.sh >"$R/out" 2>"$R/err") &
  pid=$!
  until grep -q '"stream"' "$FAKE_ORK_DIR/calls.log" 2>/dev/null || [ "$tries" -ge 100 ]; do
    tries=$((tries + 1))
    sleep 0.1
  done
  sleep 0.2
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null && STATUS=0 || STATUS=$?
  unset FAKE_ORK_HANG
  check "the script was following the stream when it was stopped" grep -q '"stream"' "$FAKE_ORK_DIR/calls.log"
  check "the stopped script exits with the signal's status" [ "$STATUS" -eq 143 ]
  check "and prints nothing about the stream it stopped" [ ! -s "$R/err" ]
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

  # The turn's deadline is for the agent. The time a person spends reading the
  # approval prompt must not count against it.
  fresh_repo slow-human
  card
  reaction 1 "$tool_use" "$blocked"
  reaction 2 "$(message evt_done 'Flagged acct_9123.')" "$(end_turn 8)"
  if (cd "$R/cli" && (sleep 3; printf 'y\n') | HELLO_TURN_TIMEOUT=2 ./l4_act.sh) >"$R/out" 2>"$R/err"; then STATUS=0; else STATUS=$?; fi
  check "an approval answered after the turn's deadline still goes through" [ "$STATUS" -eq 0 ]
  check "and the turn continues after it" out_has "[agent]  Flagged acct_9123."
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

  # `ork local` reports the retry inside the error.
  fresh_repo retrying-nested
  card
  reaction 1 \
    '{"id":"evt_err","type":"session.error","error":{"type":"unknown_error","message":"server_error (status 502)","retry_status":{"type":"retrying"}}}' \
    "$(message evt_ok ok)" "$(end_turn nested)"
  run "" l1_hello.sh
  check "a retry reported inside the error is not fatal" [ "$STATUS" -eq 0 ]
  check "and is marked as retrying too" out_has "[error]  server_error (status 502) (retrying)"

  fresh_repo exhausted-nested
  card
  reaction 1 \
    '{"id":"evt_err","type":"session.error","error":{"type":"unknown_error","message":"API key is invalid.","retry_status":{"type":"exhausted"}}}' \
    '{"id":"evt_idle_n","type":"session.status_idle","stop_reason":{"type":"retries_exhausted"}}'
  run "" l1_hello.sh
  check "an exhausted retry exits 1" [ "$STATUS" -eq 1 ]
  check "and is not marked as retrying" bash -c "! grep -qF '(retrying)' '$R/out'"

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
  check "local key uses only x-api-key" json_is '.api_key_set and (.access_token_set | not)' "$FAKE_ORK_DIR/auth.json"
}

test_local_stack() {
  local tool_use='{"id":"evt_tool_1","type":"agent.mcp_tool_use","name":"insert_multiple_rows","mcp_server_name":"risingwave","input":{"table_name":"flagged_accounts","columns":"account_id, reason","values_list":"('"'"'acct_0042'"'"', '"'"'5 failed logins then a success'"'"')"}}'
  local blocked='{"id":"evt_idle_ask","type":"session.status_idle","stop_reason":{"type":"requires_action","event_ids":["evt_tool_1"]}}'

  fresh_repo local-stack
  local_env
  reaction 1 "$(message evt_a 'Hello from your laptop!')" "$(end_turn local1)"
  run "" l1_hello.sh
  check "local L1 succeeds" [ "$STATUS" -eq 0 ]
  check "local L1 reads agent/local/" called_with "agent create" "definition_sha=$SHA_L1"
  check "the local stack keeps its ids in its own file" local_state_is agent_id agent_1
  check "and not in the cloud one" [ ! -e "$R/.orca-state/jane.json" ]
  check "remembers the local session" local_state_is session_id sess_1

  reaction 2 \
    '{"id":"evt_q","type":"agent.mcp_tool_use","name":"run_select_query","mcp_server_name":"risingwave","input":{"query":"SELECT * FROM login_failures"}}' \
    "$(message evt_c 'acct_0042 looks taken over.')" "$(end_turn local2)"
  run "" l3_live_context.sh
  check "local L3 succeeds" [ "$STATUS" -eq 0 ]
  check "local L3 carries the local fingerprint" called_with "agent update agent_1" "definition_sha=$SHA_L3_LOCAL"
  check "local L3 attaches the RisingWave MCP server" called_with "agent update agent_1" "name=risingwave,type=url,url=$LOCAL_MCP_URL"
  check "the local MCP server takes no credential, so no vault is created" [ "$(calls_of "agent vaults create")" -eq 0 ]
  check "and none is looked up" [ "$(calls_of "agent vaults")" -eq 0 ]
  check "the local session has no vault" \
    called '["agent","sessions","create","--agent","agent_1","--agent-version","2","--environment-id","env_1","--title","L3: live context","-o","json"]'
  check "prints the local version line" out_has "hello-agent-jane v2: + RisingWave MCP (one read-only SQL tool)"
  check "shows the local tool call" out_has '[tool]   run_select_query {"query": "SELECT * FROM login_failures"}'

  reaction 3 "$tool_use" "$blocked"
  reaction 4 "$(message evt_done 'Flagged acct_0042.')" "$(end_turn local4)"
  run $'y\n' l4_act.sh
  check "local L4 succeeds" [ "$STATUS" -eq 0 ]
  check "local L4 carries the local fingerprint" called_with "agent update agent_1" "definition_sha=$SHA_L4_LOCAL"
  check "asks before the local insert" out_has "[approve?] The agent wants to run insert_multiple_rows with:"
  check "sends allow for the local insert" \
    called '["agent","sessions","events","send","tool-confirmation","--session","sess_3","--tool-use-id","evt_tool_1","--decision","allow","-o","json"]'
  check "local L4 creates no vault either" [ "$(calls_of "agent vaults")" -eq 0 ]

  run "" cleanup.sh
  check "local cleanup succeeds" [ "$STATUS" -eq 0 ]
  check "local cleanup archives the agent" out_has "removed agent agent_1"
  check "local cleanup forgets the local ids" [ ! -f "$R/.orca-state/jane.local.json" ]

  fresh_repo local-missing-url
  local_env
  sed -i.bak '/RW_MCP_URL=/d' "$R/.env"
  run "" l3_live_context.sh
  check "a local .env without the MCP address fails" [ "$STATUS" -eq 1 ]
  check "and says to write .env again" err_has "Missing RW_MCP_URL: the agent definition needs it. Run local/write-env.sh in the repo root to write .env again (Local course, Lab 0)."

  fresh_repo local-missing-model
  local_env
  sed -i.bak '/ORCA_MODEL=/d' "$R/.env"
  run "" l1_hello.sh
  check "a local .env missing a value points at write-env, not the team card" \
    err_has "Missing ORCA_MODEL. Run local/write-env.sh in the repo root to write .env again (Local course, Lab 0)."

  fresh_repo bad-stack
  card
  echo "TUTORIAL_STACK=laptop" >>"$R/.env"
  run "" l1_hello.sh
  check "an unknown stack fails" [ "$STATUS" -eq 1 ]
  check "and names the two that exist" err_has "TUTORIAL_STACK must be cloud or local."
}

test_lab_ork() {
  fresh_repo lab-ork
  card
  lab_ork agent get @agent_id -o json
  check "a placeholder with no id yet fails" [ "$STATUS" -eq 1 ]
  check "and says a lab script has to run first" err_has "No agent_id yet"
  check "and calls no ork" [ ! -s "$FAKE_ORK_DIR/calls.log" ]

  reaction 1 "$(message evt_a 'Hello!')" "$(end_turn lab1)"
  run "" l1_hello.sh
  lab_ork agent get @agent_id -o json
  check "lab-ork succeeds once the agent exists" [ "$STATUS" -eq 0 ]
  check "fills in the agent id" called '["agent","get","agent_1","-o","json"]'
  check "prints what ork prints" json_is '.id == "agent_1"' "$R/out"
  check "uses the team card's Bearer key" json_is '.access_token_set and (.api_key_set | not)' "$FAKE_ORK_DIR/auth.json"

  lab_ork agent sessions events stream --session @session_id --timeout 1s
  check "fills in the session id" called '["agent","sessions","events","stream","--session","sess_1","--timeout","1s"]'

  lab_ork agent environments get @environment_id -o json
  check "fills in the environment id" called '["agent","environments","get","env_1","-o","json"]'

  lab_ork agent get @nonsense -o json
  check "anything else goes to ork as typed" called '["agent","get","@nonsense","-o","json"]'

  fresh_repo lab-ork-local
  local_env
  reaction 1 "$(message evt_a 'Hello!')" "$(end_turn lab2)"
  run "" l1_hello.sh
  lab_ork agent get @agent_id -o json
  check "lab-ork reads the local stack's ids" called '["agent","get","agent_1","-o","json"]'
  check "and uses the local workspace key" json_is '.api_key_set and (.access_token_set | not)' "$FAKE_ORK_DIR/auth.json"

  fresh_repo lab-ork-no-env
  lab_ork agent get @agent_id -o json
  check "lab-ork without .env fails" [ "$STATUS" -eq 1 ]
  check "and says how to get one" err_has "Copy .env.cloud.example to .env"

  # The checks of all three paths go through lab-ork, so a missing ork is not a
  # reason to change path.
  fresh_repo lab-ork-no-ork
  card
  if (cd "$R" && PATH=/usr/bin:/bin ./lab-ork agent list -o json) >"$R/out" 2>"$R/err"; then STATUS=0; else STATUS=$?; fi
  check "lab-ork without ork fails" [ "$STATUS" -eq 1 ]
  check "and says every path needs ork" err_has "Every path uses it"
  check "and does not send the learner to another path" bash -c "! grep -qF 'take the Python or TypeScript path' '$R/err'"
}

test_mcp_oauth() {
  fresh_repo oauth
  card
  # Omitted SN_MCP_AUTH defaults to OAuth.
  sed -i.bak '/SN_MCP_AUTH=/d' "$R/.env"
  cat >>"$R/.env" <<EOF
SN_MCP_OAUTH_ISSUER=https://auth.example.com/
SN_MCP_OAUTH_SCOPE="openid profile email offline_access"
EOF
  export ORCA_API_KEY=stale-local ORCA_ACCESS_TOKEN=stale-bearer
  # The configured local key has priority. Unset it to exercise hosted Bearer.
  unset ORCA_API_KEY
  reaction 1 "$(message evt_a 'Live data!')" "$(end_turn oauth)"
  run "" l3_live_context.sh
  unset ORCA_ACCESS_TOKEN
  check "OAuth L3 succeeds" [ "$STATUS" -eq 0 ]
  check "OAuth invokes native discovery and browser flow" called "$(jq -cn --arg url "$MCP_URL" '["agent","vaults","credentials","create","--vault","vlt_1","--display-name","streamnative-mcp","--mcp-server-url",$url,"--oauth-issuer","https://auth.example.com/","--oauth-scope","openid profile email offline_access","-o","json"]')"
  check "OAuth stores no static bearer credential" json_is '.[0].auth.type == "mcp_oauth"' "$FAKE_ORK_DIR/creds/vlt_1.json"
  check "OAuth child uses only Registry Bearer" json_is '.access_token_set and (.api_key_set | not)' "$FAKE_ORK_DIR/auth.json"
  # shellcheck disable=SC2016  # the child shell expands its own positional argument
  check "OAuth state contains no tokens" bash -c '! grep -q "test-key" "$1"' _ "$R/.orca-state/jane.json"

  reaction 2 "$(message evt_b 'Still connected!')" "$(end_turn reuse)"
  run "" l4_act.sh
  check "L4 reuses L3 OAuth credential" [ "$(calls_of "agent vaults credentials create")" -eq 1 ]
  check "OAuth L4 succeeds" [ "$STATUS" -eq 0 ]

  jq '.[0].auth.type = "static_bearer"' "$FAKE_ORK_DIR/creds/vlt_1.json" >"$R/creds.tmp"
  mv "$R/creds.tmp" "$FAKE_ORK_DIR/creds/vlt_1.json"
  reaction 3 "$(message evt_c 'New OAuth credential!')" "$(end_turn replace)"
  run "" l3_live_context.sh
  check "static credentials do not satisfy OAuth mode" [ "$(calls_of "agent vaults credentials create")" -eq 2 ]

  fresh_repo oauth-fail
  card
  export SN_MCP_AUTH=oauth
  export FAKE_ORK_FAIL="agent vaults credentials create:401"
  run "" l3_live_context.sh
  unset SN_MCP_AUTH
  check "OAuth failure stops L3" [ "$STATUS" -ne 0 ]
  check "OAuth failure has setup guidance" err_has "MCP OAuth authorization failed"
  check "OAuth failure names the lab to run again" err_has "run the Lab 3 script again"
  check "no session after OAuth failure" [ "$(calls_of "agent sessions create")" -eq 0 ]
}

test_mcp_oauth
test_local_registry_key
test_local_stack
test_lab_ork
test_missing_team_card
test_l1_creates_everything
test_turns_ignore_history_and_duplicates
test_turns_on_an_engine_that_neither_stamps_nor_echoes_sent_events
test_a_script_stopped_mid_turn_says_nothing_about_its_stream
test_bare_stream_lines
test_l4_approval
test_errors
test_environment_name_taken
test_cleanup_tolerates_missing_resources
test_team_card_parsing

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
