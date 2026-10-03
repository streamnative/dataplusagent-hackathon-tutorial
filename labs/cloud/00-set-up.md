# Lab 0: Set up

**Cloud course** · 10 minutes, plus 5 on your own · CLI, Python, or TypeScript

You fill in `.env` from your instance on StreamNative Cloud, load the login
stream into your Kafka cluster, and run the doctor. When this lab is done, the
Agent Engine, Kafka, and Schema Registry in your instance all answer, and your
topic holds 246 logins.

## Before you start

- You can log in to StreamNative Cloud. The organizers added you to the
  hackathon organization, made you an **instance** of your own, and gave you a
  **service account** in it: its name and its **API key**.
- In your instance there is a **Kafka cluster**, an **agent workspace**, and a
  **SQL workspace** that imports your Kafka cluster. If you have not created
  them yet, see [Before you arrive](../../docs/before-you-arrive.md).
- You have [`snctl`](https://docs.streamnative.io/tools/cli/snctl/snctl-overview),
  logged in to the hackathon organization:

  ```bash
  brew install streamnative/streamnative/snctl
  snctl config init
  snctl auth login                          # opens your browser
  snctl config set --organization <org>     # the hackathon organization's id, o-...
  ```

- You cloned this repository and opened a terminal in it. The terminal runs
  `bash`: on Windows that is WSL or Git Bash, on every path, because the checks
  are `bash` commands.
- You have `git`, [`ork`](https://github.com/orca-ae/orca-cli) v0.6.0 or newer,
  and [`jq`](https://jqlang.org/download/). `ork` does the first MCP login in
  Lab 3 for all three paths, and `ork` with `jq` runs the checks in every lab.

## Step 1: Install your path

Pick **one** path.

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

## Step 2: Fill in `.env` from your instance

Open a second terminal at the repository root and copy the template:

```bash
cp .env.cloud.example .env
```

`.env` is git-ignored. It will hold your key: do not commit it or paste it
anywhere. Put your service account in it first, as the organizers gave it to
you:

```text
SN_API_KEY=<the API key>
SN_SERVICE_ACCOUNT=<name>@<org>.auth.streamnative.cloud
```

Then find the names of your three resources. Each list shows the instance a
resource belongs to; the SQL catalog ties your Kafka cluster to your SQL
workspace:

```bash
snctl get kafkaclusters -o custom-columns=NAME:.metadata.name,DISPLAY:.spec.displayName,INSTANCE:.spec.instanceName
snctl get workspaces -o custom-columns=NAME:.metadata.name,DISPLAY:.spec.displayName,INSTANCE:.spec.instanceName
snctl get sqlcatalogs -o custom-columns=NAME:.metadata.name,KAFKA_CLUSTER:.spec.sourceRef.name,SQL_WORKSPACE:.spec.workspaceRef.name
```

Each prints something like this. Use the rows with your instance:

```text
NAME        DISPLAY       INSTANCE
c-abc1234   ana-kafka     ana
```

Now ask for each address, and write it into `.env`:

| `.env` line | Command | Write it as |
|---|---|---|
| `ORCA_BASE_URL` | `snctl get workspace <agent workspace> -o jsonpath='{.status.serviceEndpoints[?(@.type=="external")].dnsName}'` | `https://` and the host |
| `KAFKA_BOOTSTRAP_SERVERS` | `snctl get kafkacluster <Kafka cluster> -o jsonpath='{.status.serviceEndpoints[?(@.type=="external")].dnsName}'` | as printed, with `:9093` |
| `SCHEMA_REGISTRY_URL` | `snctl get schemaregistry <Kafka cluster> -o jsonpath='{.status.serviceEndpoints[?(@.type=="external")].dnsName}'` | `https://` and the host |
| `SN_MCP_URL` | (no command: it is built from two names) | `https://mcp.streamnative.cloud/mcp/x/<org>/sqlworkspace.compute.streamnative.io/<SQL workspace>` |

The schema registry has the same name as its Kafka cluster. Leave the other
lines as they are: the MCP server uses a separate browser login in Lab 3, so
`SN_MCP_AUTH=oauth` stays, and `SN_MCP_OAUTH_ISSUER` stays empty.

### Check

One authenticated read of your Agent Engine. It prints `true` when the address
and the key in `.env` are accepted.

```bash
./lab-ork agent list -o json | jq -e 'has("data")'
```

Before you filled in `.env`, the same command says
`Missing ORCA_BASE_URL, SN_API_KEY` instead: the two values it needs.

## Step 3: Load the login stream

Your Kafka cluster is new and empty. Create the login topic in it. The first
`snctl kafka` command opens your browser for one more login:

```bash
snctl context use --instance <your instance> --kafka-cluster <Kafka cluster>
snctl kafka admin topics create security.login_events --partitions 1
```

```text
Topic 'security.login_events' created successfully with 1 partitions and replication factor 1
```

Then load the stream into it. In your path's folder:

| Python | TypeScript | CLI |
|---|---|---|
| `python seed.py` | `npm run seed` | `(cd ../python && .venv/bin/python seed.py)` or `(cd ../typescript && npm run seed)` |

```text
Loaded 246 logins for 91 accounts into security.login_events.
```

The seeder replays [`data/login_events.jsonl`](../../data/login_events.jsonl):
synthetic logins at a fictional bank, with their timestamps moved to now. It
also registers the topic's Avro schema, which SQL Workspace needs in Lab 2.
Run it again, from any path, and it refuses to load a second copy, which would
double every count in Lab 2:

```text
security.login_events already holds 246 events, so it is seeded. To load another copy anyway: python seed.py --force
```

### Check

Run the doctor. It checks your laptop, then each service in `.env`, and a failed
check prints its fix on the next line.

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
Before this step, the `Kafka` and `Schema Registry` lines fail: the topic and
its schema are not there yet.

Still failing after two tries? Raise your hand, or see
[Troubleshooting](troubleshooting.md).

## Check your understanding

**1. The doctor prints `WAIT  MCP OAuth`. What should you do?**

- A. Fix it now: the doctor has to print only `PASS`.
- B. Nothing yet: Lab 3 does the browser login this check waits for.
- C. Ask the organizers for a new API key.

<details>
<summary>Answer</summary>

**B.** The MCP server wants an OAuth login, and the lab script does it the first
time the agent needs the server. `WAIT` means "not ready, and not your mistake".
A real problem prints `FAIL` and its fix.

</details>

**2. Where does `ORCA_BASE_URL` come from?**

- A. Your Kafka cluster's address.
- B. Your agent workspace's external endpoint.
- C. The MCP server.

<details>
<summary>Answer</summary>

**B.** The Agent Engine runs in your agent workspace. The Kafka cluster gives
you `KAFKA_BOOTSTRAP_SERVERS`, and the SQL workspace gives you `SN_MCP_URL`.

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

- `.env` holds the addresses of your three resources and your service account's
  key. `snctl` reads the addresses from your instance. `.env` is git-ignored.
- Your Kafka cluster starts empty: you created the topic and loaded it.
- The doctor checks each service and prints the fix for a failure.
- `./lab-ork` is how you look at your Agent Engine from the terminal.

## What's next

[Lab 1: Hello, agent](01-hello-agent.md)
