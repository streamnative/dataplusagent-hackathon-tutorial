# Lab 0: Set up from a team card

**Cloud course** · 8 minutes, plus 5 on your own · CLI, Python, or TypeScript

The organizers created an environment for your team on StreamNative Cloud. You
build your **team card** from it, put it in `.env`, load the login stream into
your team's Kafka cluster, and run the doctor. When this lab is done, the Agent
Engine, Kafka, and Schema Registry on your card all answer, and your topic
holds 246 logins.

Your team is not in the organizers' environment sheet?
[Lab 0: Set up](00-set-up.md) starts from an instance of your own instead. Both
end in the same place, and Lab 1 is the same after either.

## Before you start

- The organizers created your team's environment and shared the **environment
  sheet** with you. On its **Team Environments** tab, one row is your team's:
  the names and addresses of a Kafka cluster, a SQL workspace that imports it,
  an agent workspace, and a service account. All of it already exists. In this
  lab you create one thing, an API key, and you do not need `snctl`.
- You know your team's number: it is the **Team ID** of your row.
- You can log in to the StreamNative Cloud console, in the organization your
  row names. You create your API key there in step 2, and Labs 2 and 3 use the
  same login.
- You cloned this repository and opened a terminal in it. The terminal runs
  `bash`: on Windows that is WSL or Git Bash, on every path, because the checks
  are `bash` commands.
- You have `git`, [`ork`](https://github.com/orca-ae/orca-cli) v0.6.0 or newer,
  and [`jq`](https://jqlang.org/download/). `ork` does the first MCP login in
  Lab 3 for all three paths, and `ork` with `jq` runs the checks in every lab.

## Step 1: Install your path

Pick **one** path. Your teammate can pick a different one.

**Python** (3.11 or newer)

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate        # Git Bash on Windows: source .venv/Scripts/activate
pip install -r requirements.txt
```

**TypeScript** (Node.js 20 or newer)

```bash
cd typescript
npm install
```

**CLI**: `ork` and `jq` are all the labs need. Set up Python or TypeScript as
above too: the doctor, the seeder, and the data injector come from one of them.

### Check

Run the doctor without the network. Every line says `PASS`.

| Python or CLI | TypeScript |
|---|---|
| `python doctor.py --offline` | `npm run doctor -- --offline` |

```text
PASS  Python 3.11+                     3.13
PASS  package runorca
PASS  package confluent-kafka[avro]
PASS  package python-dotenv
PASS  ork                              found
PASS  jq                               found

All good: you're ready.
```

## Step 2: Build your team card in `.env`

Your team card is your team's row in the environment sheet, plus an API key
that you create. `.env` is where you write it down.

Open a second terminal at the repository root and copy the template:

```bash
cp .env.cloud.example .env
```

`.env` is git-ignored. It will hold your key: do not commit it or paste it
anywhere.

**From the sheet.** Open the environment sheet on the **Team Environments** tab
and find the row with your **Team ID**. Six lines of `.env` come from that row:

| `.env` line | Column in your row | Write it as |
|---|---|---|
| `SN_SERVICE_ACCOUNT` | **Service Account**, with **StreamNative Cloud Organization** | `<Service Account>@<Organization>.auth.streamnative.cloud`. A cell that already ends in `.auth.streamnative.cloud` goes in as it is |
| `ORCA_BASE_URL` | **Agent Workspace Endpoint** | `https://` and the host, with no `/v1` |
| `KAFKA_BOOTSTRAP_SERVERS` | **Broker URL** | as it is: the host and its port, `:9093` |
| `SCHEMA_REGISTRY_URL` | **Schema Registry URL** | as it is, with `https://` |
| `SN_MCP_URL` | **SQL Workspace MCP Endpoint** | as it is |
| `SN_SQL_DATABASE` | **SQL Database** | as it is. It is the database you open in Lab 2, and it is not your SQL workspace's name |

A cell you need is empty? Ask a facilitator. One value you can build yourself:
the MCP endpoint is
`https://mcp.streamnative.cloud/mcp/x/<Organization>/sqlworkspace.compute.streamnative.io/<SQL Workspace Name>`,
from two other cells of your row.

**Your API key.** The sheet holds no keys. You create one in the StreamNative
Cloud console, for the service account in your row:

1. Log in to the console, in the organization your row names.
2. Open the organization's **Settings**. Under **Access & Control**, click
   **Service Accounts**, then click your team's service account.
3. Click **Create API key**. Give the key a **Name** that nobody else in the
   organization uses, in lowercase letters, digits, and dashes: your team and
   your name work, such as `team07-ana`. Leave **Expiration** at 30 days, and
   click **Create**.
4. The next window shows the key, once. Click **Copy**, paste the key into
   `.env` as `SN_API_KEY` with nothing in front of it, then click **Close**. If
   you lose the key, create another.

If **Create API key** is greyed out, your login may not create keys: ask a
facilitator.

Leave the other lines as they are: the MCP server uses a separate browser login
in Lab 3, so `SN_MCP_AUTH=oauth` stays, and `SN_MCP_OAUTH_ISSUER` stays empty.

Your finished card has these seven lines filled in:

```text
SN_API_KEY=<the key you copied>
SN_SERVICE_ACCOUNT=<service account>@<organization>.auth.streamnative.cloud
ORCA_BASE_URL=https://<agent workspace host>
KAFKA_BOOTSTRAP_SERVERS=<broker host>:9093
SCHEMA_REGISTRY_URL=https://<schema registry host>
SN_MCP_URL=https://mcp.streamnative.cloud/mcp/x/<organization>/sqlworkspace.compute.streamnative.io/<SQL workspace>
SN_SQL_DATABASE=<SQL database>
```

**Two people share one environment.** Your teammate fills in the same six lines
from the same row, and can create a key of their own for the same service
account. You both work in the same Kafka cluster and the same SQL database.
Your agents stay apart: each is named after its owner's OS user name, like
`hello-agent-ana`. If the two of you have the same user name, each set
`PARTICIPANT` in `.env` to a name of your own. In Lab 2 the view and the table
are created once for the team: if your teammate got there first, the `CREATE`
statement says they already exist, and you go on to the step's check. The reset
script that Lab 4 mentions drops them for both of you, so agree before one of
you runs it.

### Check

One authenticated read of your Agent Engine. It prints `true` when the endpoint
and the key on your card are accepted.

```bash
./lab-ork agent list -o json | jq -e 'has("data")'
```

Before you filled in `.env`, the same command says
`Missing ORCA_BASE_URL, SN_API_KEY` instead: the two values it needs.

## Step 3: Load the login stream

The course reads one topic in your team's Kafka cluster,
`security.login_events`. It needs the login stream once, for the whole team.
**One of you** runs the seeder, in your path's folder:

| Python | TypeScript | CLI |
|---|---|---|
| `python seed.py` | `npm run seed` | `(cd ../python && .venv/bin/python seed.py)` or `(cd ../typescript && npm run seed)` |

It prints one of two lines, and both are fine. A topic that was empty is now
loaded:

```text
Loaded 246 logins for 91 accounts into security.login_events.
```

A topic that the organizers or your teammate loaded before you is left as it is:

```text
security.login_events already holds 246 events, so it is seeded. To load another copy anyway: python seed.py --force
```

Do not use `--force`: a second copy would double every count in Lab 2. The
number is higher than 246 once someone on your team has run Lab 3, and the
TypeScript seeder ends the line with `npm run seed -- --force`.

The seeder replays [`data/login_events.jsonl`](../../data/login_events.jsonl):
synthetic logins at a fictional bank, with their timestamps moved to now. It
also registers the topic's Avro schema, which SQL Workspace needs in Lab 2.

If it says `The topic security.login_events does not exist yet`, the topic was
not created with your environment. Raise your hand, or create it yourself with
`snctl`: [Lab 0: Set up](00-set-up.md), step 3.

### Check

Run the doctor. It checks your laptop, then each service on your card, and a
failed check prints its fix on the next line.

| Python | TypeScript | CLI |
|---|---|---|
| `python doctor.py` | `npm run doctor` | `(cd ../python && .venv/bin/python doctor.py)` or `(cd ../typescript && npm run doctor)` |

After the lines from step 1, it prints:

```text
PASS  .env                             cloud stack, participant: ana
PASS  ORCA_BASE_URL                    https://...
PASS  Agent Engine                     API key accepted
PASS  Kafka                            security.login_events has 1 partition(s)
PASS  Schema Registry                  security.login_events-value v1
PASS  login topic schema               has account_id, event_time, ip_address, result, failure_reason
WAIT  MCP OAuth                        no tutorial vault yet
      next: Nothing to do now: Lab 3 opens your browser to authorize the MCP server. Run doctor again after it.

You're ready. 1 check(s) wait for a later lab.
```

`WAIT` is not a failure. The MCP server needs a login that only Lab 3 can do.
On a topic that nobody has loaded yet, the `Schema Registry` line fails before
this step: the seeder is what registers the schema.

Still failing after two tries? Raise your hand, or see
[Troubleshooting](troubleshooting.md).

## Check your understanding

**1. The doctor prints `WAIT  MCP OAuth`. What should you do?**

- A. Fix it now: the doctor has to print only `PASS`.
- B. Nothing yet: Lab 3 does the browser login this check waits for.
- C. Create a new API key.

<details>
<summary>Answer</summary>

**B.** The MCP server wants an OAuth login, and the lab script does it the first
time the agent needs the server. `WAIT` means "not ready, and not your mistake".
A real problem prints `FAIL` and its fix.

</details>

**2. The seeder says `security.login_events already holds 246 events, so it is seeded`. What should you do?**

- A. Run it again with `--force`, so that your copy is loaded too.
- B. Nothing: the stream is there already, loaded by the organizers or by your teammate.
- C. Ask for a new Kafka cluster.

<details>
<summary>Answer</summary>

**B.** Your team shares one topic, and it needs the 246 logins once. A second
copy would double every count in Lab 2.

</details>

**3. What does `./lab-ork` add to `ork`?**

- A. It is a different CLI with its own commands.
- B. It points `ork` at your Agent Engine with the key from `.env`, and fills in the ids your scripts saved.
- C. It runs the lab's steps for you.

<details>
<summary>Answer</summary>

**B.** Everything after `./lab-ork` goes to `ork` as you typed it. The wrapper
only supplies the endpoint, the credential, and the four `@..._id` words.

</details>

## Try it yourself

Make the doctor fail on purpose, so you know what a failure looks like before a
real one. Change one value in `.env` so that a check fails, read the fix the
doctor prints, then put the value back.

### Check

The doctor ends on the "ready" line again.

```bash
(cd python && .venv/bin/python doctor.py) | tail -n 1
```

On the TypeScript path, use `npm --prefix typescript run doctor | tail -n 1`.

<details>
<summary>Solution</summary>

Add `/v1` to the end of `ORCA_BASE_URL` and run the doctor:

```text
FAIL  ORCA_BASE_URL                    https://<your-host>/v1
      fix: Use the host root only: ORCA_BASE_URL=https://<your-host>
```

The doctor does not call an endpoint it can see is wrong. It skips the Agent
Engine check, tells you the exact value to use, and ends with
`1 check(s) failed`. Remove the `/v1` and run it again.

</details>

## Recap

- `.env` holds your team card: six values from your team's row in the
  environment sheet, and an API key you created for your team's service
  account. It is git-ignored.
- Your team shares that environment. The login stream is loaded once, and the
  seeder refuses a second copy.
- The doctor checks each service on the card and prints the fix for a failure.
- `./lab-ork` is how you look at your Agent Engine from the terminal.

## What's next

[Lab 1: Hello, agent](01-hello-agent.md)
