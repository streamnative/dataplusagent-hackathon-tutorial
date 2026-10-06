# Lab 0: Set up from a team card

**Cloud course** · 5 minutes, plus 5 on your own · CLI, Python, or TypeScript

You put your team card in `.env`, load the login stream into your team's Kafka
cluster, and run the doctor. When this lab is done, the Agent Engine, Kafka,
and Schema Registry on your card all answer, and your topic holds 246 logins.

No team card? [Lab 0: Set up](00-set-up.md) starts from an instance of your own
instead. Both end in the same place, and Lab 1 is the same after either.

## Before you start

- You have your **team card** from the organizers: an **API key**, and the
  addresses of the environment they created for your team on StreamNative
  Cloud. That environment is a Kafka cluster, a SQL workspace that imports it,
  an agent workspace, and the service account the key belongs to. Everything on
  the card already exists: you create nothing, and you do not need `snctl`.
- You can log in to StreamNative Cloud, and the organizers added your login to
  your team's environment. This lab does not use that login; Labs 2 and 3 do.
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

## Step 2: Fill in `.env` from your team card

Open a second terminal at the repository root and copy the template:

```bash
cp .env.cloud.example .env
```

`.env` is git-ignored. It will hold your team's key: do not commit it or paste
it anywhere. Give each of these lines its value from the card:

| `.env` line | On your card | Write it as |
|---|---|---|
| `SN_API_KEY` | API key | the raw key, with no `token:` in front |
| `SN_SERVICE_ACCOUNT` | Service account | `<name>@<org>.auth.streamnative.cloud`. If the card has only the name, add the rest, with the organization id from the card (`o-...`) |
| `ORCA_BASE_URL` | Agent workspace endpoint | `https://` and the host, with no `/v1` |
| `KAFKA_BOOTSTRAP_SERVERS` | Broker URL | the host and its port, `:9093` |
| `SCHEMA_REGISTRY_URL` | Schema registry URL | `https://` and the host |
| `SN_MCP_URL` | SQL workspace MCP endpoint | `https://mcp.streamnative.cloud/mcp/x/<org>/sqlworkspace.compute.streamnative.io/<SQL workspace>` |
| `SN_SQL_DATABASE` | SQL database | as given. It is the name of your SQL catalog, not of your SQL workspace |

If your card already is a list of `NAME=value` lines, paste each one over the
empty line with the same name.

`SN_SQL_DATABASE` is the database you use in Lab 2 and the agent targets in
Labs 3 and 4. Leave the other lines as they are: the MCP server uses a separate
browser login in Lab 3, so `SN_MCP_AUTH=oauth` stays, and `SN_MCP_OAUTH_ISSUER`
stays empty.

**Two people share one team card.** Your teammate fills in the same values, and
you both work in the same Kafka cluster and the same SQL database. Your agents
stay apart: each is named after its owner's OS user name, like
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
- C. Ask for a new team card.

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

- `.env` holds your team card: the addresses of your team's environment and its
  key. It is git-ignored.
- Your team shares that environment. The login stream is loaded once, and the
  seeder refuses a second copy.
- The doctor checks each service on the card and prints the fix for a failure.
- `./lab-ork` is how you look at your Agent Engine from the terminal.

## What's next

[Lab 1: Hello, agent](01-hello-agent.md)
