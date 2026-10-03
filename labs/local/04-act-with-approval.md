# Lab 4: Agent acts, human approves

**Local course** · 5 minutes, plus 5 on your own · CLI, Python, or TypeScript

You give your agent one tool that writes, and a policy that makes it wait for
you. When this lab is done, the agent has flagged an account because you said
yes, and has not flagged another because you said no.

## Before you start

- You finished [Lab 3](03-live-context.md): the agent reads `login_failures`.
- `flagged_accounts` exists (Lab 2, step 3).
- One terminal is in your path's folder, a second one is at the repository root.

## Step 1: Ask the agent to act, and approve

In your path's folder:

| CLI | Python | TypeScript |
|---|---|---|
| `./l4_act.sh` | `python l4_act.py` | `npm run l4` |

The agent gets a new version with one write tool. It queries the view and
describes the flag table before it proposes an insert. Then the session pauses,
before anything is written. From one run, shortened:

```text
hello-agent-ana v3: + insert into flagged_accounts, only with human approval
[you]    Flag the account most likely to be under attack right now.
[agent]  I'll query the live data and check the `flagged_accounts` table structure at the same time.
[tool]   run_select_query {"query": "SELECT account_id, failed_logins, successful_logins, distinct_ips, last_seen FROM login_failures ORDER BY failed_logins DE…
[tool]   describe_table {"table_name": "flagged_accounts"}
[result] {"result":"[\n  {\n    \"account_id\": \"acct_9640\",\n    \"failed_logins\": 6,\n    \"successful_logins\": 1,\n    \"distinct_ips\": 1,\n    \"last_…
[result] {"result":"{\"Name\":{\"0\":\"account_id\",\"1\":\"reason\",\"2\":\"flagged_at\",\"3\":\"_rw_timestamp\",\"4\":\"primary key\",\"5\":\"distribution ke…
[agent]  Two accounts meet the takeover criteria (5+ fails + at least 1 success). **acct_9640** is the top threat ... Submitting the flag now for human approval.
[tool]   insert_multiple_rows {"table_name": "flagged_accounts", "columns": "account_id, reason", "values_list": "('acct_9640', '6 failed logins followed by 1 …

[approve?] The agent wants to run insert_multiple_rows with:
{
  "table_name": "flagged_accounts",
  "columns": "account_id, reason",
  "values_list": "('acct_9640', '6 failed logins followed by 1 successful login from 1 distinct IP, indicating likely account takeover as of 2026-10-03 00:57 UTC')"
}
Allow it? [y/N]
```

Read what it wants to write, then type `y`. The insert runs, and the agent
usually reads the row back to confirm it:

```text
Allow it? [y/N] y
[result] {"result":"Multiple rows inserted successfully into public.flagged_accounts"}
[agent]  Insert approved and written. Verifying now:
[tool]   run_select_query {"query": "SELECT account_id, reason, flagged_at FROM flagged_accounts WHERE account_id = 'acct_9640'"}
...
```

The agent leaves `flagged_at` out. The table's default, `now()`, fills it in.

**Leave the conversation open** for step 2.

### Check

From the repository root. The session holds your decision: this prints the
confirmation you sent.

```bash
./lab-ork agent sessions events list --session @session_id --event-type user.tool_confirmation --order asc -o json | jq -e '.data[] | select(.result == "allow") | {tool_use_id, result}'
```

```json
{
  "tool_use_id": "evt_01a0ff45-0b03-739f-97cc-61c45b6cf3c3",
  "result": "allow"
}
```

And the row is there:

```bash
local/sql.sh -c "SELECT * FROM flagged_accounts"
```

```text
 account_id |                                                              reason                                                              |          flagged_at
------------+----------------------------------------------------------------------------------------------------------------------------------+-------------------------------
 acct_9640  | 6 failed logins followed by 1 successful login from 1 distinct IP, indicating likely account takeover as of 2026-10-03 00:57 UTC | 2026-10-03 00:58:29.586+00:00
(1 row)
```

## Step 2: Ask again, and deny

At the prompt, ask the agent to flag a different account, and answer `n` this
time:

```text
Ask again (Enter to quit): Now flag acct_0042 as well.
[you]    Now flag acct_0042 as well.
[agent]  Querying fresh numbers for acct_0042 first.
...
[approve?] The agent wants to run insert_multiple_rows with:
...
Allow it? [y/N] n
[error] The human reviewer denied this action.
[agent]  The human reviewer **denied** this flag. `acct_0042` has not been added to `flagged_accounts` and I will not retry the insert.
```

The `[error]` line is the result the agent got back for its tool call: a human
denied it. The agent does not retry. Press Enter to end the conversation.

### Check

The session holds the denial, with the reason the agent was given.

```bash
./lab-ork agent sessions events list --session @session_id --event-type user.tool_confirmation --order asc -o json | jq -e '.data[] | select(.result == "deny") | {tool_use_id, result, deny_message}'
```

```json
{
  "tool_use_id": "evt_01a0ff45-459b-776e-b0f9-9e2eb912650d",
  "result": "deny",
  "deny_message": "The human reviewer denied this action."
}
```

The table still has one row: this prints `1`.

```bash
local/sql.sh -tA -c "SELECT count(*) FROM flagged_accounts"
```

## Step 3: Read the policy that made it wait

Nothing in the prompt made the agent stop. Look at the agent's tools:

```bash
./lab-ork agent get @agent_id -o json | jq -c '.tools[].configs[] | {name, policy: .permission_policy.type}'
```

```json
{"name":"run_select_query","policy":"always_allow"}
{"name":"describe_table","policy":"always_allow"}
{"name":"insert_multiple_rows","policy":"always_ask"}
```

**What changed** ([`agent/local/l4-act.json`](../../agent/local/l4-act.json)):
the read-only `describe_table` lets the agent see the table's columns, and
`insert_multiple_rows` uses `permission_policy: always_ask`. When the agent calls
it, the session emits `agent.mcp_tool_use` and goes idle with
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

In [`agent/local/l4-act.json`](../../agent/local/l4-act.json), change the policy
of `run_select_query` from `always_allow` to `always_ask`, then run the Lab 4
script again. The agent gets a new version, and the first thing you see is an
approval prompt for a `SELECT`.

Put the file back afterwards (`git checkout agent/local/l4-act.json`). Asking
for every read is the right default for a tool you do not trust yet, and the
wrong one for a tool the agent calls ten times a minute.

</details>

## Clean up

In your path's folder, archive your agent and environment:

| CLI | Python | TypeScript |
|---|---|---|
| `./cleanup.sh` | `python cleanup.py` | `npm run cleanup` |

An environment with session history cannot be deleted; archiving keeps that
history available.

Then stop the stacks, at the repository root. Your topic, view, and table stay
for next time:

```bash
local/down.sh
```

Two other commands are for starting over. Run one only if you mean it:

- `local/sql.sh < sql/local/99_reset.sql` drops the view, the table, and the
  source, so that you can take Lab 2 again. The topic and its events stay.
- `local/down.sh --reset` deletes both stacks and their data. The next start is
  Lab 0.

## Recap

You built the shape of most data + agent applications, and you ran all of it:

- **A stream** (Ursa for Kafka) that holds the facts as they happen.
- **A materialized view** (RisingWave) that keeps a running summary: the agent's
  always-fresh context.
- **An agent** (Orca Agent Engine) that reads that context itself, through an
  allow-list of tools.
- **A human approval gate** on the one action that changes something.

## What's next

Swap the topic, the view, and the action, and you have your own project. Ideas
and next steps: [Go further](../../docs/go-further.md). The same labs on
StreamNative Cloud are the [Cloud course](../cloud/README.md).
