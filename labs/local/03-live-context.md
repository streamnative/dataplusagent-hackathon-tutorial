# Lab 3: Agent + live context

**Local course** · 9 minutes, plus 5 on your own · CLI, Python, or TypeScript

You give your agent one read-only SQL tool, ask it who is under attack, then
change the data and ask again. When this lab is done, the agent answers from the
materialized view, and its answer changes when the stream does.

## Before you start

- You finished [Lab 2](02-streaming-sql.md): `login_failures` exists.
- `local/engine.sh --check` passes. If the engine was restarted since Lab 0,
  run `local/engine.sh` first.
- One terminal is in your path's folder, a second one is at the repository root.

## Step 1: Give the agent a SQL tool, and ask

In your path's folder:

| CLI | Python | TypeScript |
|---|---|---|
| `./l3_live_context.sh` | `python l3_live_context.py` | `npm run l3` |

Your agent gets a new version, and answers *"Which accounts look like an account
takeover right now?"* by querying `login_failures` itself. The `[tool]` line
shows the SQL it runs, and `[result]` the start of what came back. From one run,
shortened:

```text
hello-agent-ana v2: + RisingWave MCP (one read-only SQL tool)
Tip: after the first answer, run `python inject.py` in another terminal and ask again.

[you]    Which accounts look like an account takeover right now?
[tool]   run_select_query {"query": "SELECT account_id, failed_logins, successful_logins, distinct_ips, last_seen FROM login_failures WHERE failed_logins >= 5 …
[result] {"result":"[\n  {\n    \"account_id\": \"acct_0042\",\n    \"failed_logins\": 5,\n    \"successful_logins\": 2,\n    \"distinct_ips\": 2,\n    \"last_…
[agent]  ⚠️ **Likely Account Takeover Detected**

| Account | Failed | Successful | Distinct IPs | Last Seen (UTC) |
|---|---|---|---|---|
| **acct_0042** | 5 | 2 | 2 | 2026-10-03 00:55:46 |

**acct_0042** matches the takeover pattern: **5 failed logins** followed by **2 successful logins** across **2 distinct IPs** ...

Ask again (Enter to quit):
```

**Leave this conversation open.** You come back to it in step 3.

### Check

From the repository root. The agent's definition now has an MCP toolset, and this
prints the tools that are enabled in it: exactly one.

```bash
./lab-ork agent get @agent_id -o json | jq -e '.tools[] | select(.type == "mcp_toolset") | [.configs[] | select(.enabled) | .name]'
```

```json
[
  "run_select_query"
]
```

Before the step it prints nothing: the Lab 1 agent has no tools.

**What changed** ([`agent/local/l3-live-context.json`](../../agent/local/l3-live-context.json)):

- `mcp_servers`: RisingWave's MCP server, at the address in `RW_MCP_URL`. That
  is `http://risingwave-mcp:8000/mcp`: the name the AI Gateway reaches it by.
- `tools`: an allow-list. The server offers more than a hundred tools, among
  them ones that drop tables. `default_config.enabled` is `false`, and one tool,
  `run_select_query`, is enabled with `always_allow`. That one tool is all the
  model is offered.
- No vault. This MCP server takes no credential, so there is nothing to store.
  On StreamNative Cloud the server wants an OAuth login, and the token lives in a
  vault on the Agent Engine, never in a prompt.

<details>
<summary>The code (Python)</summary>

```python
layer = load_layer("l3-live-context", config.stack)
agent = ensure_agent(client, state, agent_params(layer, config))

vault_ids = mcp_vault_ids(client, state, config)   # [] on the local stack

session = open_session(client, state, environment_id, agent, "L3: live context", vault_ids=vault_ids)
chat(client, session.id, QUESTION, send_first=config.stack == "local")
```
</details>

<details>
<summary>The code (TypeScript)</summary>

```ts
const layer = loadLayer('l3-live-context', config.stack);
const agent = await ensureAgent(client, state, agentParams(layer, config));

const vaultIds = await mcpVaultIds(client, state, config); // [] on the local stack

const session = await openSession(client, state, environmentId, agent, 'L3: live context', { vaultIds });
await chat(client, session.id, QUESTION, { sendFirst: config.stack === 'local' });
```
</details>

<details>
<summary>The commands (CLI)</summary>

```bash
ork agent update <agent id> --version 1 --model "$ORCA_MODEL" \
  --system "$(jq -r .system ../agent/local/l3-live-context.json)" \
  --mcp-server "name=risingwave,type=url,url=$RW_MCP_URL" \
  --tool-json "$(jq -c '.tools[0]' ../agent/local/l3-live-context.json)" -o json

ork agent sessions create --agent <agent id> --agent-version 2 \
  --environment-id <environment id> --title "L3: live context" -o json
```
</details>

## Step 2: Inject a fresh attack

In your **second terminal**, at the repository root, write a new brute-force
burst into the login topic:

| Python (and CLI path) | TypeScript (and CLI path) |
|---|---|
| `(cd python && .venv/bin/python inject.py)` | `npm --prefix typescript run inject` |

```text
Injected 6 failed logins + 1 success for acct_9640 from 203.0.113.167 into security.login_events.
Ask your agent again, or run this SQL:  SELECT * FROM login_failures WHERE account_id = 'acct_9640';
```

It attacks a new account, `acct_9…`, picked at random: yours has another number
and address. The seeder loaded no account in that range.

### Check

The view already has the new account. This prints a line; it printed nothing
before the step. The view takes a second or two to catch up, so if you were
quick and it prints nothing, run it again.

```bash
local/sql.sh -tA -c "SELECT account_id, failed_logins, successful_logins FROM login_failures WHERE account_id LIKE 'acct_9%'"
```

```text
acct_9640|6|1
```

Nobody refreshed anything: the events landed in Kafka, and the view updated
itself.

## Step 3: Ask again

Back in the first terminal, where the conversation is still open, ask the same
question again:

```text
Ask again (Enter to quit): Which accounts look like an account takeover right now?
[you]    Which accounts look like an account takeover right now?
[tool]   run_select_query {"query": "SELECT account_id, failed_logins, successful_logins, distinct_ips, last_seen FROM login_failures WHERE failed_logins >= 5 …
[result] {"result":"[\n  {\n    \"account_id\": \"acct_9640\",\n    \"failed_logins\": 6,\n    \"successful_logins\": 1,\n    \"distinct_ips\": 1,\n    \"last_…
[agent]  ⚠️ **2 Likely Account Takeovers Detected** (updated live)

| Account | Failed | Successful | Distinct IPs | Last Seen (UTC) |
|---|---|---|---|---|
| **acct_9640** | 6 | 1 | 1 | 2026-10-03 00:57:35 |
| **acct_0042** | 5 | 2 | 2 | 2026-10-03 00:55:46 |

**New since last check:** **acct_9640** just appeared ...
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
  | map(select(.type == "agent.mcp_tool_use" and .name == "run_select_query"))
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

## Check your understanding

**1. RisingWave's MCP server offers a tool that drops tables. Can your agent call it?**

- A. Yes, if the model decides to.
- B. No: `default_config.enabled` is `false`, so only the tools named in `configs` exist for the agent.
- C. Only with human approval.

<details>
<summary>Answer</summary>

**B.** The toolset is an allow-list. A tool that is not enabled is not offered
to the model at all, and a call to it is refused.

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

**3. The agent's definition says the MCP server is at `http://risingwave-mcp:8000/mcp`. Who connects to that address?**

- A. Your terminal
- B. The model provider
- C. The AI Gateway, on the agent's behalf

<details>
<summary>Answer</summary>

**C.** The harness asks the gateway, and the gateway makes the call. That is
why the name has to resolve on the engine's network, and why
`local/engine.sh` had to put the host on the gateway's allowlist.

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
./lab-ork agent sessions events list --session @session_id --event-type agent.mcp_tool_use --order asc --limit 200 -o json | jq -e '.data[] | select(.name == "run_select_query") | .input.query'
```

<details>
<summary>Solution</summary>

Run the script, let it answer the first question, then type at the prompt:

```text
Ask again (Enter to quit): Which account has logged in from the most distinct IP addresses, and how many?
```

In one run, the agent wrote
`SELECT account_id, failed_logins, successful_logins, distinct_ips, last_seen FROM login_failures ORDER BY distinct_ips DESC LIMIT 1`.
You gave it a view and a tool, not a list of queries.

</details>

## Recap

- The agent reads the view itself, through an allow-list of one tool out of more
  than a hundred.
- Every MCP call goes through the AI Gateway.
- Fresh context came from the stream and the view. Nothing about the agent
  changed between the two answers.

## What's next

[Lab 4: Agent acts, human approves](04-act-with-approval.md)
