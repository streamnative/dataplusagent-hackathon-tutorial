# Lab 4: Agent acts, human approves

**Cloud course** · 5 minutes, plus 5 on your own · CLI, Python, or TypeScript

You give your agent one tool that writes, and a policy that makes it wait for
you. When this lab is done, the agent has flagged an account because you said
yes, and has not flagged another because you said no.

## Before you start

- You finished [Lab 3](03-live-context.md): the agent reads `login_failures`,
  and the browser login for the MCP server is done.
- `flagged_accounts` exists in your SQL workspace's database (Lab 2, step 3).
- Your SQL workspace's MCP access is read-write; the organizers set this up.
  Read-only access offers the agent no tool that writes: see
  [Troubleshooting](troubleshooting.md).
- One terminal is in your path's folder, a second one is at the repository root.

## Step 1: Ask the agent to act, and approve

In your path's folder:

| CLI | Python | TypeScript |
|---|---|---|
| `./l4_act.sh` | `python l4_act.py` | `npm run l4` |

The agent gets a new version with one write tool. It queries the view, describes
the flag table, and reads the database time before it proposes an insert. Then
the session pauses, before anything is written:

```text
[approve?] The agent wants to run sql_workspace_insert_rows with:
{
  "database": "<your database>",
  "schema": "public",
  "table": "flagged_accounts",
  "rows": [{
    "account_id": "acct_9…",
    "reason": "6 failed logins then a success from one new IP",
    "flagged_at": "2026-10-07T17:30:00Z"
  }]
}
Allow it? [y/N]
```

Read what it wants to write, then type `y`.

The MCP insert tool requires every writable column, including nullable ones, and
does not apply table defaults. That is why the agent supplies `flagged_at`
itself, from the database's clock.

**Leave the conversation open** for step 2.

### Check

From the repository root. The session holds your decision: this prints the
confirmation you sent.

```bash
./lab-ork agent sessions events list --session @session_id --event-type user.tool_confirmation --order asc -o json | jq -e '.data[] | select(.result == "allow") | {tool_use_id, result}'
```

And the row is there. In SQL Workspace:

```sql
SELECT * FROM flagged_accounts;
```

## Step 2: Ask again, and deny

At the prompt, ask the agent to flag a different account, and answer `n` this
time:

```text
Ask again (Enter to quit): Now flag acct_0042 as well.
[approve?] The agent wants to run sql_workspace_insert_rows with:
...
Allow it? [y/N] n
[error] The human reviewer denied this action.
[agent]  The human reviewer **denied** this flag. `acct_0042` has **not** been added to `flagged_accounts`, and I will not retry.
```

The `[error]` line is the result the agent got back for its tool call: a human
denied it. The agent does not retry. Press Enter to end the conversation.

### Check

The session holds the denial, with the reason the agent was given.

```bash
./lab-ork agent sessions events list --session @session_id --event-type user.tool_confirmation --order asc -o json | jq -e '.data[] | select(.result == "deny") | {tool_use_id, result, deny_message}'
```

In SQL Workspace, `SELECT * FROM flagged_accounts;` still returns one row.

## Step 3: Read the policy that made it wait

Nothing in the prompt made the agent stop. Look at the agent's tools:

```bash
./lab-ork agent get @agent_id -o json | jq -c '.tools[].configs[] | {name, policy: .permission_policy.type}'
```

```json
{"name":"sql_workspace_list_databases","policy":"always_allow"}
{"name":"sql_workspace_query","policy":"always_allow"}
{"name":"sql_workspace_describe_table","policy":"always_allow"}
{"name":"sql_workspace_insert_rows","policy":"always_ask"}
```

**What changed** ([`agent/cloud/l4-act.json`](../../agent/cloud/l4-act.json)):
the read-only `sql_workspace_describe_table` checks the required columns, and
`sql_workspace_insert_rows` uses `permission_policy: always_ask`. When the agent
calls it, the session emits `agent.mcp_tool_use` and goes idle with
`stop_reason: requires_action`. Your script answers with a
`user.tool_confirmation`: `allow`, or `deny` with a reason. On the CLI that is:

```bash
ork agent sessions events send tool-confirmation --session <session id> \
  --tool-use-id <tool use event id> --decision allow
```

### Check

Exactly one tool needs your approval. This prints its name.

```bash
./lab-ork agent get @agent_id -o json | jq -e '.tools[].configs[] | select(.permission_policy.type == "always_ask") | .name'
```

## Check your understanding

**1. The agent calls a tool whose policy is `always_ask`. What happens to the session?**

- A. The tool runs, and you are told afterwards.
- B. The session goes idle with `stop_reason: requires_action` until someone sends a `user.tool_confirmation`.
- C. The call fails and the agent tries another tool.

<details>
<summary>Answer</summary>

**B.** The pause is in the Agent Engine, not in the model's manners. Nothing is
written until a client answers.

</details>

**2. You answered `n`. What did the agent learn?**

- A. Nothing: the tool call looked like a timeout.
- B. That a human denied the action, with the reason your script sent.
- C. That the table is read-only.

<details>
<summary>Answer</summary>

**B.** A denial comes back to the agent as the result of its tool call, with the
`deny_message`. Its instructions say to report that and not retry.

</details>

**3. Why is the approval a policy on the tool, and not a sentence in the system prompt?**

- A. A prompt is a request the model can misread or be talked out of; a policy is enforced outside the model.
- B. Policies are shorter to write.
- C. The system prompt cannot mention tools.

<details>
<summary>Answer</summary>

**A.** Governance that depends on the model behaving is not governance. The
allow-list and the policy hold whatever the model decides to try.

</details>

## Try it yourself

Put a human in front of the agent's reads as well. Change one policy so that
every SQL query pauses for approval, run the lab script, and approve a query.

### Check

Two tools need approval now. It prints both names.

```bash
./lab-ork agent get @agent_id -o json | jq -e '[.tools[].configs[] | select(.permission_policy.type == "always_ask") | .name] | select(length == 2)'
```

<details>
<summary>Solution</summary>

In [`agent/cloud/l4-act.json`](../../agent/cloud/l4-act.json), change the policy
of `sql_workspace_query` from `always_allow` to `always_ask`, then run the Lab 4
script again. The agent gets a new version, and the first thing you see is an
approval prompt for a `SELECT`.

Put the file back afterwards (`git checkout agent/cloud/l4-act.json`). Asking
for every read is the right default for a tool you do not trust yet, and the
wrong one for a tool the agent calls ten times a minute.

</details>

## Clean up

| CLI | Python | TypeScript |
|---|---|---|
| `./cleanup.sh` | `python cleanup.py` | `npm run cleanup` |

This archives your agent and environment, and deletes your vault. An environment
with session history cannot be deleted; archiving keeps that history available.
To start Lab 2 over, run [`sql/cloud/99_reset.sql`](../../sql/cloud/99_reset.sql)
in SQL Workspace.

## Recap

You built the shape of most data + agent applications:

- **A stream** (Kafka) that holds the facts as they happen.
- **A materialized view** that keeps a running summary: the agent's always-fresh
  context.
- **An agent** that reads that context itself, through an allow-list of tools.
- **A human approval gate** on the one action that changes something.

## What's next

Swap the topic, the view, and the action, and you have your hackathon project.
Ideas and next steps: [Go further](../../docs/go-further.md).
