# Lab 3: Agent + live context

**Cloud course** · 9 minutes, plus 5 on your own · CLI, Python, or TypeScript

You give your agent two read-only SQL tools, ask it who is under attack, then
change the data and ask again. When this lab is done, the agent answers from the
materialized view, and its answer changes when the stream does.

## Before you start

- You finished [Lab 2](02-streaming-sql.md): `login_failures` exists in your
  SQL workspace's database.
- Set `SN_SQL_DATABASE` in `.env` to that database's SQL catalog name (Lab 0,
  step 2). The agent is instructed to use it for every SQL call, with no
  fallback to another database. This is prompt guidance, not MCP permission
  isolation; an empty value retains legacy automatic discovery.
- One terminal is in your path's folder, a second one is at the repository root.
- `ork` v0.6.0 or newer is installed. All three paths use it for the first MCP
  login.

## Step 1: Give the agent SQL tools, and ask

In your path's folder:

| CLI | Python | TypeScript |
|---|---|---|
| `./l3_live_context.sh` | `python l3_live_context.py` | `npm run l3` |

**The first run opens your browser.** The StreamNative MCP server wants an OAuth
login. Approve it. The script waits, then continues; later runs reuse the
credential without another login.

Your agent gets a new version, and answers *"Which accounts look like an account
takeover right now?"* by querying `login_failures` itself. The `[tool]` lines
show the SQL it runs:

```text
hello-agent-ana v2: + StreamNative MCP (read-only SQL tools)
Tip: after the first answer, run `python inject.py` in another terminal and ask again.

[you]    Which accounts look like an account takeover right now?
[tool]   sql_workspace_list_databases {}
[tool]   sql_workspace_query {"database": "...", "sql": "SELECT account_id, failed_logins, ..."}
[agent]  acct_0042: 5 failed logins followed by a success, from 2 IP addresses ...

Ask again (Enter to quit):
```

**Leave this conversation open.** You come back to it in step 3.

### Check

From the repository root. The agent's definition now has an MCP toolset, and this
prints the tools that are enabled in it: exactly two.

```bash
./lab-ork agent get @agent_id -o json | jq -e '.tools[] | select(.type == "mcp_toolset") | [.configs[] | select(.enabled) | .name]'
```

```json
[
  "sql_workspace_list_databases",
  "sql_workspace_query"
]
```

Before the step it prints nothing: the Lab 1 agent has no tools.

**What changed** ([`agent/cloud/l3-live-context.json`](../../agent/cloud/l3-live-context.json)):

- `mcp_servers`: the StreamNative MCP server for your SQL Workspace.
- `tools`: an allow-list. Two read-only tools run without asking
  (`always_allow`); every other tool on that server is disabled.
- A **vault**: the MCP server's OAuth credential is created through `ork` and
  stored server-side. The session references the vault by id, so tokens never
  enter the prompt, `.env`, or the state file, and the server can refresh them.

<details>
<summary>The code (Python)</summary>

```python
layer = load_layer("l3-live-context", config.stack)
agent = ensure_agent(client, state, agent_params(layer, config))

vault_ids = mcp_vault_ids(client, state, config)

session = open_session(client, state, environment_id, agent, "L3: live context", vault_ids=vault_ids)
chat(client, session.id, QUESTION, send_first=config.stack == "local")
```
</details>

<details>
<summary>The code (TypeScript)</summary>

```ts
const layer = loadLayer('l3-live-context', config.stack);
const agent = await ensureAgent(client, state, agentParams(layer, config));

const vaultIds = await mcpVaultIds(client, state, config);

const session = await openSession(client, state, environmentId, agent, 'L3: live context', { vaultIds });
await chat(client, session.id, QUESTION, { sendFirst: config.stack === 'local' });
```
</details>

<details>
<summary>The commands (CLI)</summary>

```bash
ork agent update <agent id> --version 1 --model "$ORCA_MODEL" \
  --system "$(jq -r .system ../agent/cloud/l3-live-context.json)" \
  --mcp-server "name=streamnative,type=url,url=$SN_MCP_URL" \
  --tool-json "$(jq -c '.tools[0]' ../agent/cloud/l3-live-context.json)" -o json

ork agent vaults create --display-name hello-vault-ana -o json
ork agent vaults credentials create --vault <vault id> --display-name streamnative-mcp \
  --mcp-server-url "$SN_MCP_URL" \
  --oauth-scope "$SN_MCP_OAUTH_SCOPE" -o json

ork agent sessions create --agent <agent id> --agent-version 2 \
  --environment-id <environment id> --vault-id <vault id> --title "L3: live context" -o json
```
</details>

## Step 2: Inject a fresh attack

In your **second terminal**, at the repository root, write a new brute-force
burst into the login topic:

| Python (and CLI path) | TypeScript (and CLI path) |
|---|---|
| `(cd python && .venv/bin/python inject.py)` | `npm --prefix typescript run inject` |

```text
Injected 6 failed logins + 1 success for acct_9123 from 203.0.113.77 into security.login_events.
Ask your agent again, or run this SQL:  SELECT * FROM login_failures WHERE account_id = 'acct_9123';
```

It attacks a new account, `acct_9…`, outside the range the topic was loaded
with.

### Check

In SQL Workspace, the view already has the new account. This returns a row; it
returned none before the step.

```sql
SELECT account_id, failed_logins, successful_logins, last_seen
FROM login_failures
WHERE account_id LIKE 'acct_9%';
```

Nobody refreshed anything: the events landed in Kafka, and the view updated
itself.

## Step 3: Ask again

Back in the first terminal, where the conversation is still open, ask the same
question again:

```text
Ask again (Enter to quit): Which accounts look like an account takeover right now?
[tool]   sql_workspace_query {"database": "...", "sql": "SELECT ..."}
[agent]  Two accounts now: acct_0042 ... and acct_9123: 6 failed logins followed by a success ...
```

The new account shows up. The agent did not change. Its context did, because it
fetches its context when it needs it instead of being handed a snapshot.

Press Enter to end the conversation.

### Check

The agent queried the view again for your second question. This prints how many
query calls it made after that question, once there is one.

```bash
./lab-ork agent sessions events list --session @session_id --order asc --limit 200 -o json | jq -e '
  .data
  | select(map(select(.type == "user.message")) | length >= 2)
  | .[(map(.type) | rindex("user.message")):]
  | map(select(.type == "agent.mcp_tool_use" and .name == "sql_workspace_query"))
  | select(length >= 1)
  | {queries_after_your_last_question: length}'
```

```json
{
  "queries_after_your_last_question": 1
}
```

Reading it line by line: take the events, oldest first; keep going only if you
asked at least twice; look at what came after your last question; keep the query
calls; print how many there are, when there is at least one. After step 1 it
prints nothing, however many queries the first answer took.

Now that the browser login is done, the doctor's `MCP OAuth` line says `PASS`
too. It checks that the stored credential still initializes the MCP server.

## Check your understanding

**1. Where is the MCP server's OAuth token after the browser login?**

- A. In `.env`
- B. In the agent's system prompt
- C. In a vault on the Agent Engine; the session only carries the vault's id

<details>
<summary>Answer</summary>

**C.** `ork` sends the tokens straight to the vault. They never enter the
prompt, your `.env`, or `.orca-state/`, and the server can refresh them.

</details>

**2. The agent's second answer included a new account. What changed between the two answers?**

- A. The agent was updated to a new version.
- B. The materialized view changed, and the agent queried it again.
- C. The agent remembered the injection from the first answer.

<details>
<summary>Answer</summary>

**B.** Same agent, same session. Its system prompt tells it to query before
every answer, so it read the view again and the view had moved.

</details>

**3. The MCP server offers many more tools than two. Why can the agent not call, say, a tool that deletes rows?**

- A. `default_config.enabled` is `false`, so every tool not named in `configs` is off.
- B. The agent does not know those tools exist, but could call them if it guessed the name.
- C. The service account lacks the permission.

<details>
<summary>Answer</summary>

**A.** The toolset is an allow-list. A tool that is not enabled is not offered
to the model at all, and a call to it is refused.

</details>

## Try it yourself

Without changing any file, get the agent to run SQL you did not see in this lab.
Start the Lab 3 script again and ask a question whose answer is in
`login_failures` but needs a different query, for example which account was seen
from the most IP addresses.

### Check

It prints the SQL of every query in the newest session, oldest first. The last
one is the agent's answer to your question.

```bash
./lab-ork agent sessions events list --session @session_id --event-type agent.mcp_tool_use --order asc --limit 200 -o json | jq -e '.data[] | select(.name == "sql_workspace_query") | .input.sql'
```

<details>
<summary>Solution</summary>

Run the script, let it answer the first question, then type at the prompt:

```text
Ask again (Enter to quit): Which account has logged in from the most distinct IP addresses, and how many?
```

The agent writes something like
`SELECT account_id, distinct_ips FROM login_failures ORDER BY distinct_ips DESC LIMIT 1`.
You gave it a view and a tool, not a list of queries.

</details>

## Recap

- The agent reads the view itself, through an allow-list of two tools.
- Its credential for the MCP server lives in a vault, not in a prompt.
- Fresh context came from the stream and the view. Nothing about the agent
  changed between the two answers.

## What's next

[Lab 4: Agent acts, human approves](04-act-with-approval.md)
