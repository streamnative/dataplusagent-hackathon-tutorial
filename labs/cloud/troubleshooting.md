# Troubleshooting: Cloud course

Run the doctor first. It checks each service in your `.env` and prints the fix
for what fails.

| Python or CLI | TypeScript |
|---|---|
| `python doctor.py` | `npm run doctor` |

Still stuck after two tries? Raise your hand.

## Symptoms

| Symptom | Fix |
|---|---|
| `pip install -r requirements.txt`: `No matching distribution found for runorca==0.3.0` | The `python3` that made your virtual environment is older than the course needs: on macOS, Apple's own is 3.9. Install Python 3.11 or newer, then make the environment again with it. In `python/`: `rm -rf .venv`, then the install commands from Lab 0 with that Python's name in place of `python3`, for example `python3.13 -m venv .venv`. |
| Doctor: `Agent Engine HTTP 401/403` | The key was rejected. A key created before its permissions must be re-created: ask a facilitator. |
| Doctor: `Kafka ... authentication` | `SN_SERVICE_ACCOUNT` must be the full principal, `<name>@<org>.auth.streamnative.cloud`; `SN_API_KEY` is the raw key. |
| Doctor: `Kafka   security.login_events: not found` | The topic is not there yet. Create it and load it: Lab 0, step 3. |
| Doctor: `Schema Registry ... not found` | The schema is registered when you load the topic: Lab 0, step 3. |
| Doctor: `WAIT  MCP OAuth` | Not a failure. Lab 3 does the browser login; run the doctor again after it. |
| `snctl kafka ...`: `organization, instance and pulsar cluster are required` | Point `snctl` at your cluster first: `snctl context use --instance <your instance> --kafka-cluster <Kafka cluster>` (Lab 0, step 3). |
| `snctl get ...` lists nothing, or another organization's resources | Set the hackathon organization: `snctl config set --organization <org>`. |
| The SQL workspace never gets ready (`snctl get sqlworkspace <name>` shows `does not enable SQLWorkspace`) | It was created in a region that has no SQL workspaces. Ask a facilitator which region to use. |
| The console cannot open your SQL workspace's database | Use `psql` instead: Lab 2, "Before you start". |
| `table or source not found: security.login_events` | Pick the database named after your SQL catalog. If your `LOGIN_TOPIC` is not `security.login_events`, use your topic's name in both Lab 2 SQL files: the source is named exactly after the topic. |
| The agent can't find `login_failures` | Create the view in your SQL workspace's database (Lab 2, step 2); the agent looks it up there. |
| `[error] connection_unavailable: sql connection unavailable` from every SQL tool | The MCP server reached your SQL workspace but could not log in to its RisingWave as you. If `psql` works (Lab 2), the SQL workspace runs a RisingWave version that does not accept that login: ask a facilitator to update it. |
| Lab 4: the agent says `sql_workspace_insert_rows` is not available or the session is read-only, and `Allow it? [y/N]` never appears | Your SQL workspace's MCP access is read-only. Lab 4 needs it read-write, which a facilitator sets for you (in the console: your SQL workspace, Settings, MCP). Then run the Lab 4 script again. |
| Other `[error]` lines from MCP tools in Lab 3 | Check `SN_MCP_URL` (your SQL workspace's route, Lab 0, step 2) and `SN_MCP_AUTH`, finish the OAuth login, then run the doctor again. |
| OAuth issuer mismatch / unsupported client authentication | Use `ork` v0.6.0 or newer and leave `SN_MCP_OAUTH_ISSUER` empty for StreamNative discovery. An explicit issuer must match an advertised authorization server. `--oauth-allow-issuer-mismatch` is only for trusted servers whose metadata issuer crosses registrable domains; StreamNative does not need it. |
| `Cannot reach the Agent Engine` | `ORCA_BASE_URL` must be `https://` and your agent workspace's external endpoint, with no `/v1`: Lab 0, step 2. |
| The agent answers from memory instead of querying | Ask again, "check the view first". The system prompt tells it to always query. |
| `./lab-ork` says `No session_id yet` | The lab step that creates it has not run on this stack. Run the lab's script first. |
| A script seems stuck at an approval | The session is waiting for you. Answer the `Allow it? [y/N]` prompt, or press Ctrl-C and run the lab script again: it starts a fresh session. |
| Nothing happens for minutes after you answer `y` or `n` (on the CLI path: `The agent did not finish its turn within 300s.`) | The Agent Engine has your decision but has not acted on it yet. Run the Lab 4 script again: it starts a fresh session. A `y` you already gave can still be applied later, so the account you approved may be in `flagged_accounts` already. |

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
  SQL workspace's database.
- Kafka: injected `acct_9…` events stay in the topic. They are harmless.
