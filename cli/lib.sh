# shellcheck shell=bash source-path=SCRIPTDIR
# Helpers for the CLI scripts: remembered ids, the agent/environment/vault
# "ensure" steps, and the loop that follows one turn of a session.
# Read l1_hello.sh first; come here for the details.

# shellcheck source=env.sh
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

HELLO_TMP=$(mktemp -d "${TMPDIR:-/tmp}/hello-cli.XXXXXX")
HELLO_STREAM_PID=""
HELLO_DENY_MESSAGE="The human reviewer denied this action."
HELLO_ROUND_SECONDS=${HELLO_ROUND_SECONDS:-15}   # how long one `events stream` call stays open
HELLO_TURN_TIMEOUT=${HELLO_TURN_TIMEOUT:-300}    # give up on a turn after this many seconds
: >"$HELLO_TMP/seen"
: >"$HELLO_TMP/tools"

hello_cleanup_tmp() {
  if [ -n "$HELLO_STREAM_PID" ]; then kill "$HELLO_STREAM_PID" 2>/dev/null || true; fi
  rm -rf "$HELLO_TMP"
}
trap hello_cleanup_tmp EXIT
trap 'exit 130' INT

# ------------------------------------------------------------- ork calls --

# ork <args> -o json. On failure ork's message is kept in $HELLO_TMP/ork.err.
ork_json() {
  ork "$@" -o json </dev/null 2>"$HELLO_TMP/ork.err"
}

ork_failed_with() {  # ork_failed_with <http status>
  grep -q "returned status $1" "$HELLO_TMP/ork.err"
}

ork_fail() {
  local message
  message=$(sed -e 's/^Error: //' "$HELLO_TMP/ork.err")
  case "$message" in
    *"no such host"* | *"connection refused"* | *"dial tcp"*)
      hello_die "Cannot reach the Agent Engine. Check ORCA_BASE_URL in .env, then run \`python doctor.py\` (or \`npm run doctor\`)." ;;
    *) hello_die "ork failed: $message
Run \`python doctor.py\` (or \`npm run doctor\`) to check your setup." ;;
  esac
}

# Succeeds, with the resource in $HELLO_LIVE, if it still exists and is not archived.
ork_get_live() {  # ork_get_live <resource command...> <id>
  if ! HELLO_LIVE=$(ork_json "$@"); then
    ork_failed_with 404 && return 1
    ork_fail
  fi
  [ "$(jq -r '.archived_at // empty' <<<"$HELLO_LIVE")" = "" ]
}

# ------------------------------------------------------------ remembered ids --
# Shared with the Python and TypeScript paths: .orca-state/<participant>.json

state_get() {
  [ -f "$HELLO_STATE_FILE" ] || return 0
  jq -r --arg key "$1" '.[$key] // empty' "$HELLO_STATE_FILE"
}

state_set() {
  local current='{}'
  [ -f "$HELLO_STATE_FILE" ] && current=$(cat "$HELLO_STATE_FILE")
  mkdir -p "$(dirname "$HELLO_STATE_FILE")"
  jq --arg key "$1" --arg value "$2" '.[$key] = $value' <<<"$current" >"$HELLO_STATE_FILE.tmp"
  mv "$HELLO_STATE_FILE.tmp" "$HELLO_STATE_FILE"
}

# ------------------------------------------------------- agent definitions --

layer_file() { printf '%s/agent/%s.json' "$HELLO_REPO_ROOT" "$1"; }

# The five fields the fingerprint covers, with ${NAME} placeholders filled
# from your team card (only mcp_servers and tools carry placeholders).
agent_definition() {  # agent_definition <layer>
  local file name
  file=$(layer_file "$1")
  for name in $(jq -r '[.mcp_servers, .tools] | .. | strings | [match("\\$\\{([A-Z0-9_]+)\\}"; "g").captures[0].string] | .[]' "$file" | sort -u); do
    [ -n "$(printenv "$name" || true)" ] ||
      hello_die "Missing $name: the agent definition needs it. Add it to .env from your team card."
  done
  jq -c --arg name "hello-agent-$HELLO_PARTICIPANT" --arg model "$ORCA_MODEL" '
    def fill: if type == "string" then gsub("\\$\\{(?<var>[A-Z0-9_]+)\\}"; $ENV[.var])
              elif type == "array" then map(fill)
              elif type == "object" then with_entries(.value |= fill)
              else . end;
    {name: $name, model: $model, system: .system, mcp_servers: (.mcp_servers | fill), tools: (.tools | fill)}
  ' "$file"
}

# Same recipe as the other languages: sha256 of compact JSON with sorted keys.
definition_sha() {
  local sha
  if command -v shasum >/dev/null; then
    sha=$(jq -cS . <<<"$1" | tr -d '\n' | shasum -a 256)
  else
    sha=$(jq -cS . <<<"$1" | tr -d '\n' | sha256sum)
  fi
  printf '%s' "${sha:0:16}"
}

# `ork agent create` or `ork agent update`, with flags built from the definition.
agent_write() {  # agent_write <definition> <sha> <layer label> [<agent id> <version>]
  local definition=$1 line
  local -a args
  args=(
    --name "$(jq -r .name <<<"$definition")"
    --model "$(jq -r .model <<<"$definition")"
    --system "$(jq -r .system <<<"$definition")"
    --metadata tutorial=dss2026-hello-world
    --metadata "layer=$3"
    --metadata "definition_sha=$2"
  )
  while IFS= read -r line; do
    [ -n "$line" ] && args+=(--mcp-server "$line")
  done < <(jq -r '.mcp_servers[] | "name=\(.name),type=\(.type),url=\(.url)"' <<<"$definition")
  while IFS= read -r line; do
    [ -n "$line" ] && args+=(--tool-json "$line")
  done < <(jq -c '.tools[]' <<<"$definition")

  if [ $# -ge 5 ]; then
    ork_json agent update "$4" --version "$5" "${args[@]}"
  else
    ork_json agent create "${args[@]}"
  fi
}

# Updates are partial and ork only sends tools/mcp_servers when there are some,
# so it cannot take them away. Going back to a layer with fewer tools therefore
# starts a fresh agent instead.
needs_fresh_agent() {  # needs_fresh_agent <definition> <current agent json>
  jq -e --argjson want "$1" '
    (($want.tools | length) == 0 and ((.tools // []) | length) > 0)
    or (($want.mcp_servers | length) == 0 and ((.mcp_servers // []) | length) > 0)
  ' <<<"$2" >/dev/null
}

# Create your agent, or update it when the layer's definition changed.
# Sets AGENT_ID, AGENT_NAME, AGENT_VERSION.
ensure_agent() {  # ensure_agent <layer>
  local definition sha label id json=""
  definition=$(agent_definition "$1")
  sha=$(definition_sha "$definition")
  label=$(jq -r .layer "$(layer_file "$1")")
  id=$(state_get agent_id)

  if [ -n "$id" ] && ork_get_live agent get "$id"; then
    if [ "$(jq -r '.metadata.definition_sha // empty' <<<"$HELLO_LIVE")" = "$sha" ]; then
      json=$HELLO_LIVE
    elif ! needs_fresh_agent "$definition" "$HELLO_LIVE"; then
      # Every update is a new version; --version guards against a concurrent edit.
      json=$(agent_write "$definition" "$sha" "$label" "$id" "$(jq -r .version <<<"$HELLO_LIVE")") || ork_fail
    else
      echo "(ork cannot remove tools from an agent, so $label starts a fresh one; the old agent is archived)" >&2
      ork agent archive "$id" >/dev/null 2>&1 || true
    fi
  fi
  if [ -z "$json" ]; then
    json=$(agent_write "$definition" "$sha" "$label") || ork_fail
    state_set agent_id "$(jq -r .id <<<"$json")"
  fi

  AGENT_ID=$(jq -r .id <<<"$json")
  # shellcheck disable=SC2034  # read by the layer scripts
  AGENT_NAME=$(jq -r .name <<<"$json")
  AGENT_VERSION=$(jq -r .version <<<"$json")
}

# ------------------------------------------------ environments and vaults --

# Sets ENVIRONMENT_ID: where your agent's sessions run. Created once, then reused.
ensure_environment() {  # ensure_environment <name>
  local json
  ENVIRONMENT_ID=$(state_get environment_id)
  if [ -n "$ENVIRONMENT_ID" ] && ork_get_live agent environments get "$ENVIRONMENT_ID"; then
    return
  fi
  if ! json=$(ork_json agent environments create --name "$1"); then
    ork_failed_with 409 || ork_fail
    # Names stay reserved after an environment is archived: pick a fresh one.
    json=$(ork_json agent environments create --name "$1-$(printf '%04x' "$RANDOM")") || ork_fail
  fi
  ENVIRONMENT_ID=$(jq -r .id <<<"$json")
  state_set environment_id "$ENVIRONMENT_ID"
}

# Sets VAULT_ID: a vault holding the credential the agent uses to call the MCP
# server. The token stays in the vault; it never enters a prompt (or your terminal).
ensure_vault() {  # ensure_vault <name> <mcp url> <token>
  local json credentials auth
  VAULT_ID=$(state_get vault_id)
  if [ -z "$VAULT_ID" ] || ! ork_get_live agent vaults get "$VAULT_ID"; then
    json=$(ork_json agent vaults create --display-name "$1") || ork_fail
    VAULT_ID=$(jq -r .id <<<"$json")
    state_set vault_id "$VAULT_ID"
  fi
  credentials=$(ork_json agent vaults credentials list --vault "$VAULT_ID") || ork_fail
  if ! jq -e --arg url "$2" '[(.data? // .)[]? | select(.auth.mcp_server_url == $url and .archived_at == null)] | length > 0' \
    <<<"$credentials" >/dev/null; then
    auth=$(jq -cn --arg url "$2" --arg token "$3" '{type: "static_bearer", mcp_server_url: $url, token: $token}')
    ork_json agent vaults credentials create --vault "$VAULT_ID" --display-name streamnative-mcp --auth-json "$auth" \
      >/dev/null || ork_fail
  fi
}

# Sets SESSION_ID: one conversation, pinned to this exact agent version.
create_session() {  # create_session <title> [vault id]
  local json
  local -a vault=()
  [ -z "${2:-}" ] || vault=(--vault-id "$2")
  json=$(ork_json agent sessions create --agent "$AGENT_ID" --agent-version "$AGENT_VERSION" \
    --environment-id "$ENVIRONMENT_ID" --title "$1" ${vault[@]+"${vault[@]}"}) || ork_fail
  # shellcheck disable=SC2034  # read by the layer scripts
  SESSION_ID=$(jq -r .id <<<"$json")
}

# -------------------------------------------------------------- one turn --

HELLO_CURSOR=0

# Read one round of `ork agent sessions events stream`, printing new events.
# Sets HELLO_STOP (end_turn, requires_action, ...), HELLO_BLOCKED, HELLO_ERROR.
follow_round() {  # follow_round <session id> <processed_at of our message>
  local line out ctl text frame id old kind stop blocked error status=0
  rm -f "$HELLO_TMP/stream"
  mkfifo "$HELLO_TMP/stream"
  ork agent sessions events stream --session "$1" --from-cursor "$HELLO_CURSOR" --timeout "${HELLO_ROUND_SECONDS}s" \
    </dev/null >"$HELLO_TMP/stream" 2>"$HELLO_TMP/ork.err" &
  HELLO_STREAM_PID=$!

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    out=$(jq -r --arg since "$2" -f "$HELLO_CLI_DIR/pretty.jq" <<<"$line")
    ctl=${out%%$'\n'*}
    text=""
    [ "$ctl" = "$out" ] || text=${out#*$'\n'}
    IFS=$'\x1f' read -r frame id old kind stop blocked error <<<"$ctl"

    [ -z "$frame" ] || HELLO_CURSOR=$frame              # --from-cursor is inclusive: duplicates are skipped below
    [ "$old" = true ] && continue                        # from an earlier turn
    grep -qxF -- "$id" "$HELLO_TMP/seen" && continue     # already shown
    printf '%s\n' "$id" >>"$HELLO_TMP/seen"

    [ -z "$text" ] || printf '%s\n' "$text"
    case "$kind" in
      agent.mcp_tool_use) jq -c 'if (has("data") and (.data | type) == "object") then .data else . end' <<<"$line" >>"$HELLO_TMP/tools" ;;
      session.error) HELLO_ERROR=$error ;;
      session.status_idle)
        HELLO_STOP=$stop
        HELLO_BLOCKED=$blocked
        break
        ;;
    esac
  done <"$HELLO_TMP/stream"

  if [ -n "$HELLO_STOP" ]; then
    kill "$HELLO_STREAM_PID" 2>/dev/null || true
    wait "$HELLO_STREAM_PID" 2>/dev/null || true
  else
    wait "$HELLO_STREAM_PID" || status=$?
    [ "$status" -eq 0 ] || ork_fail
  fi
  HELLO_STREAM_PID=""
}

# Show the tool call the agent wants to make, and let the human decide.
ask_human() {  # ask_human <tool use id>  -> exit status 0 to allow
  local tool answer
  tool=$(jq -c --arg id "$1" 'select(.id == $id)' "$HELLO_TMP/tools" | head -n 1)
  [ -n "$tool" ] || tool=$(jq -cn --arg id "$1" '{id: $id}')
  printf '\n[approve?] The agent wants to run %s with:\n' "$(jq -r '.name // "None"' <<<"$tool")"
  jq '.input // {}' <<<"$tool"
  printf 'Allow it? [y/N] '
  IFS= read -r answer || answer=""
  answer=$(hello_trim "$answer" | tr '[:upper:]' '[:lower:]')
  [ "$answer" = y ] || [ "$answer" = yes ]
}

# Send one message and follow the session until the agent's turn ends.
run_turn() {  # run_turn <session id> <text> [approve]
  local sent since deadline id
  sent=$(ork_json agent sessions events send message --session "$1" --text "$2") || ork_fail
  since=$(jq -r '.data[0].processed_at // empty' <<<"$sent")
  deadline=$((SECONDS + HELLO_TURN_TIMEOUT))
  HELLO_ERROR=""

  while :; do
    [ "$SECONDS" -lt "$deadline" ] || hello_die "The agent did not finish its turn within ${HELLO_TURN_TIMEOUT}s."
    HELLO_STOP=""
    HELLO_BLOCKED=""
    follow_round "$1" "$since"
    case "$HELLO_STOP" in
      "") ;;                                              # the stream round ended mid-turn: open another
      end_turn) return 0 ;;
      requires_action)
        [ "${3:-}" = approve ] ||
          hello_die "The agent is waiting for human approval, but this script has no approver."
        for id in $HELLO_BLOCKED; do
          if ask_human "$id"; then
            ork_json agent sessions events send tool-confirmation --session "$1" --tool-use-id "$id" \
              --decision allow >/dev/null || ork_fail
          else
            ork_json agent sessions events send tool-confirmation --session "$1" --tool-use-id "$id" \
              --decision deny --deny-message "$HELLO_DENY_MESSAGE" >/dev/null || ork_fail
          fi
        done
        ;;
      *) hello_die "The agent stopped ($HELLO_STOP): ${HELLO_ERROR:-no details}" ;;
    esac
  done
}

# Ask the first question, then whatever the participant types, until they type nothing.
chat() {  # chat <session id> <first question> [approve]
  local question=$2
  while [ -n "$question" ]; do
    printf '[you]    %s\n' "$question"
    run_turn "$1" "$question" "${3:-}"
    printf '\nAsk again (Enter to quit): '
    IFS= read -r question || question=""
    question=$(hello_trim "$question")
  done
}
