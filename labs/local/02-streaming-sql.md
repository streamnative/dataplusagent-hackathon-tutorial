# Lab 2: Hello, streaming SQL

**Local course** · 8 minutes, plus 5 on your own · `psql`, through `local/sql.sh`

You connect RisingWave to the login topic and turn it into a materialized view
that keeps a running summary per account. When this lab is done, there is a view
your agent can read in Lab 3, and a table it can write to in Lab 4.

## Before you start

- You finished [Lab 1](01-hello-agent.md), and the streaming stack from
  [Lab 0](00-set-up.md) is running.
- Work in the terminal at the repository root.
  [`local/sql.sh`](../../local/sql.sh) is `psql` against the RisingWave on your
  laptop, with nothing to install:

  ```bash
  local/sql.sh                                    # a prompt (\q to leave)
  local/sql.sh -c "SELECT 1"                      # one statement
  local/sql.sh < sql/local/01_explore.sql         # a file
  ```

## Step 1: Connect RisingWave to the topic

RisingWave does not know about the topic yet. A **source** tells it where the
topic is and how to decode it.

```bash
local/sql.sh < sql/local/00_source.sql
```

```sql
CREATE SOURCE IF NOT EXISTS "security.login_events" (*)
WITH (
  connector = 'kafka',
  topic = 'security.login_events',
  properties.bootstrap.server = 'kafka:19092',
  scan.startup.mode = 'earliest'
) FORMAT PLAIN ENCODE AVRO (
  schema.registry = 'http://schema-registry:8081'
);
```

The columns come from the Avro schema the seeder registered: `(*)` takes all of
them. RisingWave runs in a container, so it reaches the broker and the registry
by their names on the stack's network (`kafka`, `schema-registry`), not by
`127.0.0.1`. The source is named after the topic; the name contains a dot, so it
is always double-quoted.

Peek at the stream. Each row is one login attempt:

```bash
local/sql.sh < sql/local/01_explore.sql
```

### Check

The source reads the whole topic: this prints `246`, the number of logins the
seeder loaded.

```bash
local/sql.sh -tA -c 'SELECT count(*) FROM "security.login_events"'
```

Before the step, the same command fails with
`table or source not found: security.login_events`.

## Step 2: Turn the stream into context

```bash
local/sql.sh < sql/local/02_login_failures.sql
```

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

A materialized view is maintained incrementally: every new login updates the
counts within seconds. There is no batch job to schedule and nothing to refresh.
That makes it good agent context: always current, and cheap to read.

RisingWave prints a `NOTICE` about snapshot backfill first. It is harmless: the
view still reads the topic from its first event.

The file ends with a query, so you also see the ten accounts with the most
failed logins. `acct_0042` is at the top: five failed logins, then a success.
That is the attacker.

### Check

The view exists and has found the account under attack. This prints one line.

```bash
local/sql.sh -tA -c "SELECT account_id, failed_logins, successful_logins, distinct_ips FROM login_failures WHERE account_id = 'acct_0042' AND failed_logins >= 5 AND successful_logins >= 1"
```

```text
acct_0042|5|2|2
```

Before the step, the same command fails with
`table or source not found: login_failures`.

## Step 3: Make room for the agent's decisions

The agent writes here in Lab 4.

```bash
local/sql.sh < sql/local/03_flagged_accounts.sql
```

```sql
CREATE TABLE flagged_accounts (
  account_id VARCHAR PRIMARY KEY,
  reason     VARCHAR,
  flagged_at TIMESTAMPTZ DEFAULT now()
);
```

### Check

The table exists and is empty: this prints `0`.

```bash
local/sql.sh -tA -c "SELECT count(*) FROM flagged_accounts"
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

**2. The source's address for Kafka is `kafka:19092`, but your `.env` says `127.0.0.1:29092`. Why two addresses for one broker?**

- A. They are two different brokers.
- B. RisingWave runs in a container and reaches the broker by its name on the stack's network; your terminal reaches the same broker through a port published on your laptop.
- C. One is for reading and one is for writing.

<details>
<summary>Answer</summary>

**B.** Inside a container, `127.0.0.1` is the container itself. Anything one
container says to another uses the service name.

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
accounts that match it, worst first, and run it with `local/sql.sh -c`.

### Check

Your query returns exactly one account. Its `last_seen` is close to the time you
seeded the topic, so yours differs from this one.

```text
 account_id | failed_logins | successful_logins | distinct_ips |           last_seen
------------+---------------+-------------------+--------------+-------------------------------
 acct_0042  |             5 |                 2 |            2 | 2026-10-07 17:30:00.000+00:00
(1 row)
```

<details>
<summary>Solution</summary>

```bash
local/sql.sh -c "SELECT * FROM login_failures WHERE failed_logins >= 5 AND successful_logins >= 1 ORDER BY failed_logins DESC"
```

This is close to what the agent runs in Lab 3. It writes the SQL itself.

</details>

## Recap

- A source connects RisingWave to a Kafka topic and decodes it with the schema
  in the registry.
- `login_failures` is a materialized view: a running summary per account, kept
  current as events arrive.
- `flagged_accounts` is an ordinary table, waiting for the agent's decisions.

## What's next

[Lab 3: Agent + live context](03-live-context.md)
