# Lab 2: Hello, streaming SQL

**Cloud course** · 8 minutes, plus 5 on your own · SQL Workspace, in the StreamNative Cloud console

You turn the login topic into a materialized view that keeps a running summary
per account. When this lab is done, there is a view your agent can read in
Lab 3, and a table it can write to in Lab 4.

## Before you start

- You finished [Lab 1](01-hello-agent.md).
- In the StreamNative Cloud console, open **SQL Workspace**, select the hackathon
  workspace, and pick your team's database. Use a new query tab for each step.
- **Align the SQL with your `.env` first.** The default Kafka topic is
  `security.login_events`, and SQL Workspace exposes its Avro source as
  `"avro.security.login_events"`. The injector and the doctor read `LOGIN_TOPIC`
  from `.env`, but SQL Workspace does not: the SQL files and the examples below
  contain a fixed source name. Check `LOGIN_TOPIC`, then replace
  `"avro.security.login_events"` with `"avro.<your LOGIN_TOPIC>"` in
  [`sql/cloud/01_explore.sql`](../../sql/cloud/01_explore.sql) and
  [`sql/cloud/02_login_failures.sql`](../../sql/cloud/02_login_failures.sql), and
  in any query copied from this page. For example,
  `LOGIN_TOPIC=security.team07_logins` requires `FROM "avro.security.team07_logins"`.
  Keep the double quotes around the entire source name, and confirm that SQL
  Workspace imported that topic as an Avro source. Keep the `login_failures`
  view name: Labs 3 and 4 query that view.

## Step 1: Peek at the stream

Run [`sql/cloud/01_explore.sql`](../../sql/cloud/01_explore.sql). Each row is
one login attempt. The topic name contains dots, so it is double-quoted.

```sql
SELECT event_time, account_id, ip_address, result, failure_reason
FROM "avro.security.login_events"
ORDER BY event_time DESC
LIMIT 20;
```

### Check

The query returns 20 rows, newest first, and `result` is `SUCCESS` or `FAILURE`.
This counts what the source holds: it returns a number greater than zero.

```sql
SELECT count(*) AS logins FROM "avro.security.login_events";
```

If it says `relation "avro.security.login_events" does not exist`, you are in
the wrong database or the source name does not match your topic: see
[Troubleshooting](troubleshooting.md).

## Step 2: Turn the stream into context

Run the first statement of
[`sql/cloud/02_login_failures.sql`](../../sql/cloud/02_login_failures.sql).

```sql
CREATE MATERIALIZED VIEW login_failures AS
SELECT
  account_id,
  COUNT(*) FILTER (WHERE result = 'FAILURE') AS failed_logins,
  COUNT(*) FILTER (WHERE result = 'SUCCESS') AS successful_logins,
  COUNT(DISTINCT ip_address)                AS distinct_ips,
  MAX(event_time)                           AS last_seen
FROM "avro.security.login_events"
GROUP BY account_id;
```

A materialized view is maintained incrementally: every new login updates the
counts within seconds. There is no batch job to schedule and nothing to refresh.
That makes it good agent context: always current, and cheap to read.

Look at it:

```sql
SELECT * FROM login_failures ORDER BY failed_logins DESC LIMIT 10;
```

`acct_0042` is near the top: failed logins, then a success. That is the
attacker.

### Check

The view exists and has found the account under attack. This returns one row.

```sql
SELECT account_id, failed_logins, successful_logins, distinct_ips
FROM login_failures
WHERE account_id = 'acct_0042' AND failed_logins >= 5 AND successful_logins >= 1;
```

Before the step, the same query fails: `login_failures` does not exist.

## Step 3: Make room for the agent's decisions

Run [`sql/cloud/03_flagged_accounts.sql`](../../sql/cloud/03_flagged_accounts.sql).
The agent writes here in Lab 4.

```sql
CREATE TABLE flagged_accounts (
  account_id VARCHAR PRIMARY KEY,
  reason     VARCHAR,
  flagged_at TIMESTAMPTZ DEFAULT now()
);
```

### Check

The table exists and is empty: this returns `0`.

```sql
SELECT count(*) AS flagged FROM flagged_accounts;
```

## Check your understanding

**1. A new login event arrives in Kafka. What has to happen for `login_failures` to include it?**

- A. Someone reruns the `CREATE MATERIALIZED VIEW` statement.
- B. A scheduled job refreshes the view.
- C. Nothing: the view is updated as the event arrives.

<details>
<summary>Answer</summary>

**C.** A materialized view is a standing query. It is maintained incrementally
as events arrive, so reading it is a cheap lookup and the result is current.

</details>

**2. Why is the source written as `"avro.security.login_events"`, in double quotes?**

- A. The name contains dots, and without quotes each dot would separate a schema from a name.
- B. Double quotes make the query case-insensitive.
- C. Quotes are required for every table in SQL Workspace.

<details>
<summary>Answer</summary>

**A.** The dots are part of the name. Quoting the whole name keeps it one
identifier.

</details>

**3. Why does an agent read a view like this instead of the raw topic?**

- A. Agents cannot read Kafka.
- B. The view answers "what is true now" in one small query, instead of the agent re-reading and counting every event.
- C. The view hides the data from the agent.

<details>
<summary>Answer</summary>

**B.** The database does the counting once, continuously. The agent's context
stays small and current, with no pipeline to babysit.

</details>

## Try it yourself

The agent's rule of thumb in Lab 3 is "five or more failed logins plus at least
one success". Write one query over `login_failures` that returns only the
accounts that match it, worst first.

### Check

Your query's result includes `acct_0042`, and no account with fewer than five
failed logins or without a success.

```text
 account_id | failed_logins | successful_logins | ...
------------+---------------+-------------------+-----
 acct_0042  |             5 |                 2 | ...
```

<details>
<summary>Solution</summary>

```sql
SELECT account_id, failed_logins, successful_logins, distinct_ips, last_seen
FROM login_failures
WHERE failed_logins >= 5 AND successful_logins >= 1
ORDER BY failed_logins DESC;
```

This is close to what the agent runs in Lab 3. It writes the SQL itself.

</details>

## Recap

- The login topic is a source you can query with SQL.
- `login_failures` is a materialized view: a running summary per account, kept
  current as events arrive.
- `flagged_accounts` is an ordinary table, waiting for the agent's decisions.

## What's next

[Lab 3: Agent + live context](03-live-context.md)
