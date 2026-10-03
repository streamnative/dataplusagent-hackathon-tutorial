# Troubleshooting: Cloud course

Run the doctor first. It checks each service on your team card and prints the
fix for what fails.

| Python or CLI | TypeScript |
|---|---|
| `python doctor.py` | `npm run doctor` |

Still stuck after two tries? Raise your hand.

## Symptoms

| Symptom | Fix |
|---|---|
| Doctor: `Agent Engine HTTP 401/403` | The key was rejected. A key created before its permissions must be re-created: ask a facilitator. |
| Doctor: `Kafka ... authentication` | `SN_SERVICE_ACCOUNT` must be the full principal, `<name>@<org>.auth.streamnative.cloud`; `SN_API_KEY` is the raw key. |
| Doctor: `WAIT  MCP OAuth` | Not a failure. Lab 3 does the browser login; run the doctor again after it. |
| The login topic isn't listed in SQL Workspace | Only topics with a registered Avro schema appear. Ask a facilitator. |
| `relation "avro.security.login_events" does not exist` | Select your team's database, and update the quoted Avro source in both Lab 2 SQL files to match `LOGIN_TOPIC` in `.env`. |
| The agent can't find `login_failures` | Create the view in your team's database (Lab 2, step 2); the agent looks it up there. |
| `[error]` lines from MCP tools in Lab 3 | Check `SN_MCP_URL` and `SN_MCP_AUTH`, finish the OAuth login, then run the doctor again. |
| OAuth issuer mismatch / unsupported client authentication | Use `ork` v0.6.0 or newer and leave `SN_MCP_OAUTH_ISSUER` empty for StreamNative discovery. An explicit issuer must match an advertised authorization server. `--oauth-allow-issuer-mismatch` is only for trusted servers whose metadata issuer crosses registrable domains; StreamNative does not need it. |
| `Cannot reach the Agent Engine` | `ORCA_BASE_URL` must be the host root from your card, with no `/v1`. |
| The agent answers from memory instead of querying | Ask again, "check the view first". The system prompt tells it to always query. |
| `./lab-ork` says `No session_id yet` | The lab step that creates it has not run on this stack. Run the lab's script first. |
| A script seems stuck at an approval | The session is waiting for you. Answer the `Allow it? [y/N]` prompt, or press Ctrl-C and run the lab script again: it starts a fresh session. |

## The MCP login in Lab 3

For the StreamNative SQL Workspace MCP server, keep `SN_MCP_AUTH=oauth`, leave
`SN_MCP_OAUTH_ISSUER` empty for automatic discovery, and use the scope from
`.env.cloud.example`.

- `ork`'s discovery accepts HTTPS issuer aliases within the same registrable
  domain and port. Only set `SN_MCP_OAUTH_ISSUER` when you have to choose between
  several advertised `authorization_servers`; copy that advertised value exactly,
  not the final issuer in the authorization-server metadata.
- `SN_API_KEY` authenticates the hosted Agent Engine, Kafka, and Schema
  Registry. It is not the OAuth MCP access token.
- All three paths use `ork` for the first MCP login, then reuse the live
  credential for the same URL and auth type from the vault remembered in
  `.orca-state/<participant>.json`. Tokens stay in the server-side vault, where
  they can be refreshed; they are never written to `.env` or local state.
- Set `SN_MCP_AUTH=static_bearer` only when your MCP server accepts `SN_API_KEY`.
- Changing the auth mode archives the previous live credential for that same URL
  before creating its replacement: the Registry permits one active credential
  per URL in a vault. If authorization fails, run Lab 3 or Lab 4 again to finish
  setup; credentials for other URLs are preserved.

## Start over

- Agent Engine: run the cleanup script of your path (`./cleanup.sh`,
  `python cleanup.py`, or `npm run cleanup`).
- SQL: run [`sql/cloud/99_reset.sql`](../../sql/cloud/99_reset.sql) in your
  team's database.
- Kafka: injected `acct_9…` events stay in the topic. They are harmless.
