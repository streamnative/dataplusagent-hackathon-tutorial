#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# L4 - Agent acts, human approves.
#
# Lets your agent insert into flagged_accounts, but only with your approval: the
# tool has an `always_ask` policy, so the session pauses until you decide.
#
#   ./l4_act.sh
#
# Needs ork and jq.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
hello_setup ORCA_BASE_URL ORCA_MODEL SN_MCP_URL

REQUEST="Flag the account most likely to be under attack right now."

ensure_environment "hello-env-$HELLO_PARTICIPANT"

# Next version again: agent/l4-act.json enables one write tool, always_ask.
ensure_agent l4-act
echo "$AGENT_NAME v$AGENT_VERSION: $(jq -r .summary "$(layer_file l4-act)")"

ensure_vault "hello-vault-$HELLO_PARTICIPANT"
create_session "L4: act with approval" "$VAULT_ID"

# When the session pauses for approval, you decide, and the script answers with
#      ork agent sessions events send tool-confirmation --session <id> --tool-use-id <id> --decision allow|deny
chat "$SESSION_ID" "$REQUEST" approve
