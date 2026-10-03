# Lab 2: Hello, streaming SQL

**Cloud course** · 8 minutes, plus 5 on your own · SQL Workspace, in the StreamNative Cloud console or with `psql`

You turn the login topic into a materialized view that keeps a running summary
per account. When this lab is done, there is a view your agent can read in
Lab 3, and a table it can write to in Lab 4.

## Before you start

- You finished [Lab 1](01-hello-agent.md).
- Open your SQL workspace. In the StreamNative Cloud console, open **SQL
  Workspace**, select your SQL workspace, and pick the database named after your
  SQL catalog (Lab 0, step 2). Use a new query tab for each step.
  This must match `SN_SQL_DATABASE` in `.env`, so you and the agent use the same
  database. SQL Workspace does not read `.env`; select the database yourself.
- If the console cannot open the database yet, use `psql` from the repository
  root instead. Look up your SQL workspace's address, then connect as `root`
  with your API key as the password:

  ```bash
  snctl get sqlworkspace <SQL workspace> -o jsonpath='{.status.endpoints[?(@.type=="sqlgateway/pgwire")].url}'
  export PGPASSWORD="$(sed -n 's/^SN_API_KEY=//p' .env)"
  psql "postgresql://root@<host>:4567/<database>?sslmode=require"
  ```

  No `psql` on your laptop? Docker has one:
  `docker run --rm -it -e PGPASSWORD postgres:16-alpine psql "postgresql://root@<host>:4567/<database>?sslmode=require"`.
- **The source is named after the topic.** Your SQL catalog imported the topic
  `security.login_events` as the source `"security.login_events"`. If
  `LOGIN_TOPIC` in `.env` is something else, use that name instead, in
  [`sql/cloud/01_explore.sql`](../../sql/cloud/01_explore.sql),
  [`sql/cloud/02_login_failures.sql`](../../sql/cloud/02_login_failures.sql), and
  the queries on this page: SQL Workspace does not read `.env`. Keep the double
  quotes around the whole name, and keep the `login_failures` view name: Labs 3
  and 4 query that view.

## Step 1: Peek at the stream

Run [`sql/cloud/01_explore.sql`](../../sql/cloud/01_explore.sql). Each row is
one login attempt. The topic name contains dots, so it is double-quoted.

```sql
SELECT event_time, account_id, ip_address, result, failure_reason
FROM "security.login_events"
ORDER BY event_time DESC
LIMIT 20;
```

### Check

The query returns 20 rows, newest first, and `result` is `SUCCESS` or `FAILURE`.
This counts what the source holds: `246`, the logins you loaded in Lab 0.

```sql
SELECT count(*) AS logins FROM "security.login_events";
```

If it says `table or source not found: security.login_events`, you are in the
wrong database, or the source name does not match your topic: see
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
FROM "security.login_events"
GROUP BY account_id;
```

It prints a `NOTICE` about snapshot backfill along with
`CREATE_MATERIALIZED_VIEW`. The notice is expected.

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

Before the step, the same query fails: `table or source not found: login_failures`.

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

**2. Why is the source written as `"security.login_events"`, in double quotes?**

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
