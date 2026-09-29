#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# L3 - Agent + live context.
#
# Upgrades your agent with read-only StreamNative MCP tools, gives the session a
# vault holding the MCP credential, and opens a conversation. Ask, run the
# injector in a second terminal, then ask again: the answer changes.
#
#   ./l3_live_context.sh
#
# Needs ork and jq. The injector is `python inject.py` or `npm run inject`.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
hello_setup ORCA_BASE_URL SN_API_KEY ORCA_MODEL SN_MCP_URL

QUESTION="Which accounts look like an account takeover right now?"

ensure_environment "hello-env-$HELLO_PARTICIPANT"

# The same agent, next version: agent/l3-live-context.json adds the MCP server.
#      ork agent update <id> --version <v> --mcp-server name=streamnative,type=url,url=<SN_MCP_URL> --tool-json <toolset>
ensure_agent l3-live-context
echo "$AGENT_NAME v$AGENT_VERSION: $(jq -r .summary "$(layer_file l3-live-context)")"

# The MCP server needs a credential. It goes in a vault, never in the prompt.
#      ork agent vaults create --display-name hello-vault-<you>
#      ork agent vaults credentials create --vault <id> --auth-json '{"type":"static_bearer",...}'
ensure_vault "hello-vault-$HELLO_PARTICIPANT" "$SN_MCP_URL" "$SN_API_KEY"

#      ork agent sessions create ... --vault-id <id>
create_session "L3: live context" "$VAULT_ID"
# shellcheck disable=SC2016  # the backticks are for the reader
printf 'Tip: after the first answer, run `python inject.py` (or `npm run inject`) in another terminal and ask again.\n\n'
chat "$SESSION_ID" "$QUESTION"
