#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# L1 - Hello, agent.
#
# Creates your agent (no tools yet), starts a session, and says hello.
#
#   ./l1_hello.sh                       # asks a default question
#   ./l1_hello.sh "your own question"
#
# Needs ork and jq. doctor and inject come from the Python or TypeScript path.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
hello_setup ORCA_BASE_URL SN_API_KEY ORCA_MODEL

QUESTION="Hi! What is the Data + Agent Hackathon, and what can you see right now?"
[ $# -eq 0 ] || QUESTION="$*"

# 1. An environment: where your agent's sessions run.
#      ork agent environments create --name hello-env-<you>
ensure_environment "hello-env-$HELLO_PARTICIPANT"

# 2. An agent: a model plus a system prompt, from agent/l1-hello.json.
#      ork agent create --name hello-agent-<you> --model <model> --system <prompt>
ensure_agent l1-hello
echo "$AGENT_NAME v$AGENT_VERSION: $(jq -r .summary "$(layer_file l1-hello)")"

# 3. A session: one conversation, pinned to this exact agent version.
#      ork agent sessions create --agent <id> --agent-version <v> --environment-id <id>
create_session "L1: hello"

# 4. Send a message and stream the agent's reply.
#      ork agent sessions events send message --session <id> --text <question>
#      ork agent sessions events stream --session <id>
printf '[you]    %s\n' "$QUESTION"
run_turn "$SESSION_ID" "$QUESTION"
