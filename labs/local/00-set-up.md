# Lab 0: Set up

**Local course** · 15 minutes, plus the image downloads and 5 on your own · CLI, Python, or TypeScript

You start the streaming stack and the Agent Engine on your laptop, load the login
stream into a diskless topic, and run the doctor. When this lab is done, every
part of the stack answers and the topic holds 246 logins.

## Before you start

- **Docker** is running, with Compose v2 (`docker compose version`).
- You have [`ork`](https://github.com/orca-ae/orca-cli) v0.6.0 or newer
  (`brew install orca-ae/tap/ork`, or a
  [release archive](https://github.com/orca-ae/orca-cli/releases) unpacked onto
  your `PATH`), and [`jq`](https://jqlang.org/download/).
- You have an **Anthropic API key**.
- You cloned this repository, and installed **one** path:

  | Python (3.11 or newer) | TypeScript (Node.js 20 or newer) |
  |---|---|
  | `cd python && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt` | `cd typescript && npm install` |

  For Python, `python3 --version` has to say 3.11 or newer. On macOS, Apple's
  own `python3` is 3.9, and with it `pip` stops at
  `No matching distribution found for runorca`. Install a newer Python and name
  it in the command, for example `python3.13 -m venv .venv`.

  The CLI path needs only `ork` and `jq` for the labs, plus one of the two
  above for the doctor, the seeder, and the injector.
- Keep two terminals open: one in your path's folder (`cli/`, `python/` or
  `typescript/`), one at the repository root. The commands in this lab run at
  the repository root unless they say otherwise.

## Step 1: Start the streaming stack

```bash
docker compose -f local/compose.yaml up -d --wait
```

The first run downloads about 4.4 GB of images. It starts six services
([`local/compose.yaml`](../../local/compose.yaml)):

- `kafka`: [Ursa for Kafka](https://openlakestream.org/docs/ursa-for-kafka), one
  broker.
- `oxia` and `object-store`: where a diskless topic keeps its metadata and its
  records.
- `schema-registry`: the Avro schema of the login topic.
- `risingwave`: streaming SQL.
- `risingwave-mcp`: RisingWave's MCP server, the agent's SQL tools.

If it fails with a port already in use, see
[Troubleshooting](troubleshooting.md) before you run it again.

### Check

The six services are running. Before the step this prints nothing.

```bash
docker compose -f local/compose.yaml ps --status running --services
```

```text
kafka
object-store
oxia
risingwave
risingwave-mcp
schema-registry
```

## Step 2: Start the Agent Engine

The engine reads your provider key when it starts, so export it in this
terminal first:

```bash
export ANTHROPIC_API_KEY=<your key>
local/engine.sh
```

[`local/engine.sh`](../../local/engine.sh) does two things, and says so in its
header:

1. It runs `ork local start --with-gateway`, with `.lab/ork` in this checkout
   as the data directory: the Agent Engine (a registry and a harness) plus the
   AI Gateway. The gateway makes every MCP call on your agent's behalf, so MCP
   tools need it.
2. It links the gateway to your MCP server. The gateway refuses private hosts
   unless they are on its allowlist, and `ork local start` writes that allowlist
   empty each time. The script adds one host, `risingwave-mcp`, restarts the
   gateway, and attaches the MCP server's container to the engine's network
   under that name.

Run `local/engine.sh` again whenever the engine has been restarted. It is safe
to run at any time.

If it stops with `port is already allocated`, another program has a port the
engine needs, usually 8080: see [Troubleshooting](troubleshooting.md).

### Check

The engine is up, has a provider key that the model provider accepts, and can
reach the MCP server. The script ends with these lines, and `--check` prints
them again without starting anything.

```bash
local/engine.sh --check
```

```text
PASS  the AI Gateway is running
PASS  the gateway has a provider key
PASS  the model provider accepts that key
PASS  the gateway allows the MCP host risingwave-mcp
PASS  the MCP server answers at http://risingwave-mcp:8000/mcp on the engine's network

The Agent Engine is up and can reach your MCP server.
```

A line that says `FAIL` prints its fix under it. While the third line fails,
your agent cannot answer. Usually the provider refused the key you exported:
export one that works and run `local/engine.sh` again.

## Step 3: Write your `.env`

Every script in this repository reads `.env` in the repository root.
[`local/write-env.sh`](../../local/write-env.sh) writes it for the local stack,
with the workspace key your Agent Engine just generated.

```bash
local/write-env.sh
```

```text
Wrote .env for the local stack (Agent Engine at http://127.0.0.1:8080).
```

`.env` is git-ignored. [`.env.local.example`](../../.env.local.example) shows
what is in it. The line `TUTORIAL_STACK=local` is what tells every script to use
the stack on your laptop.

### Check

One authenticated read of your Agent Engine. It prints `true` when the endpoint
and the key in `.env` are accepted.

```bash
./lab-ork agent list -o json | jq -e 'has("data")'
```

[`./lab-ork`](../../lab-ork) is `ork` with the endpoint and key from `.env`. You
use it for the checks in every lab.

## Step 4: Create the diskless topic and load it

Create the login topic. `ursa.storage.enable=true` is what makes it diskless:
its records go to the object store through Ursa, not to the broker's disk.

```bash
docker compose -f local/compose.yaml exec kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka:19092 --create --topic security.login_events \
  --partitions 1 --replication-factor 1 --config ursa.storage.enable=true
```

```text
Created topic security.login_events.
```

Kafka also prints a warning about periods in topic names. It is harmless here.

Now load the login stream. In your path's folder:

| Python | TypeScript | CLI |
|---|---|---|
| `python seed.py` | `npm run seed` | `(cd ../python && .venv/bin/python seed.py)` or `(cd ../typescript && npm run seed)` |

```text
Loaded 246 logins for 91 accounts into security.login_events.
```

The seeder replays [`data/login_events.jsonl`](../../data/login_events.jsonl):
synthetic logins at a fictional bank, with their timestamps moved to now. It
also registers the topic's Avro schema, which RisingWave needs in Lab 2.

Look at where the records went. The topic's data is objects in the object
store:

```bash
docker compose -f local/compose.yaml exec object-store curl -s \
  --aws-sigv4 aws:amz:us-east-1:s3 --user ursa-local:ursa-local-secret \
  "http://localhost:9000/kafka-ursa?list-type=2&prefix=ursa/wal/" | grep -o '<Key>[^<]*</Key>'
```

It prints one line per object. The names carry the time of the write, so yours
differ:

```text
<Key>ursa/wal/2026/10/07/17/30/00/2be58851-f143-498c-bfaa-752c4e49720d</Key>
<Key>ursa/wal/2026/10/07/17/30/00/7a611976-386a-46d6-a50a-802db13593d0</Key>
```

### Check

Run the doctor in your path's folder. It checks every part of the local stack,
and prints the fix for anything that fails.

| Python | TypeScript | CLI |
|---|---|---|
| `python doctor.py` | `npm run doctor` | `(cd ../python && .venv/bin/python doctor.py)` or `(cd ../typescript && npm run doctor)` |

The Python doctor prints this. The TypeScript one starts with Node and its own
packages instead.

```text
PASS  Python 3.11+                     3.13
PASS  package runorca
PASS  package confluent-kafka[avro]
PASS  package python-dotenv
PASS  ork                              found
PASS  jq                               found
PASS  .env                             local stack, participant: ana
PASS  docker                           found
PASS  ORCA_BASE_URL                    http://127.0.0.1:8080
PASS  Agent Engine                     API key accepted
PASS  Kafka                            security.login_events has 1 partition(s)
PASS  Schema Registry                  security.login_events-value v1
PASS  login topic schema               has account_id, event_time, ip_address, result, failure_reason
PASS  MCP tools                        run_select_query, describe_table, insert_multiple_rows
PASS  RisingWave through MCP           SELECT 1 returned a row

All good: you're ready.
```

Before this step, the `Kafka` and `Schema Registry` lines fail: the topic and
its schema are not there yet.

## Check your understanding

**1. Where are the records of `security.login_events` stored?**

- A. On the Kafka broker's disk, like any topic
- B. In the object store, written through Ursa; the broker keeps only metadata
- C. In RisingWave

<details>
<summary>Answer</summary>

**B.** The topic was created with `ursa.storage.enable=true`, which makes it
diskless. You listed the object yourself in step 4. A topic created without that
setting is an ordinary Kafka topic on the same broker.

</details>

**2. Why does `local/engine.sh` start the engine with `--with-gateway`?**

- A. The gateway makes every MCP call on the agent's behalf, so without it the agent has no tools.
- B. The gateway is where agents are stored.
- C. It makes the model faster.

<details>
<summary>Answer</summary>

**A.** The harness never calls an MCP server itself. It asks the AI Gateway,
which decides whether the destination is allowed and attaches credentials. That
is also why the gateway has to be told about `risingwave-mcp`.

</details>

**3. Which line of `.env` tells the scripts to use the stack on your laptop?**

- A. `ORCA_BASE_URL=http://127.0.0.1:8080`
- B. `TUTORIAL_STACK=local`
- C. `PARTICIPANT=`

<details>
<summary>Answer</summary>

**B.** With it, the scripts talk to Kafka without credentials, read the agent
definitions in `agent/local/`, and use no vault.

</details>

## Try it yourself

Stop everything, bring it back, and confirm that nothing was lost. Your topic,
its 246 events, and your engine's key should all survive a stop.

### Check

After the restart, the doctor passes again, and the seeder refuses to load a
second copy because the topic still holds the first one. The seeder says the
same before you stop anything: the point is that it still says so afterwards.

```bash
(cd python && .venv/bin/python seed.py)
```

```text
security.login_events already holds 246 events, so it is seeded. To load another copy anyway: python seed.py --force
```

On the TypeScript path, use `npm --prefix typescript run seed`.

<details>
<summary>Solution</summary>

```bash
local/down.sh
docker compose -f local/compose.yaml up -d --wait
local/engine.sh
```

`local/down.sh` stops both stacks and keeps their volumes. Starting is the same
two commands as in steps 1 and 2. You do not run `local/write-env.sh` again: the
engine kept its key. `ANTHROPIC_API_KEY` must still be exported in the terminal
where you run `local/engine.sh`.

</details>

## Clean up

Nothing to clean up yet: the next labs use what you started. For later, there
are two ways to stop:

- `local/down.sh` stops both stacks. Your topic, view, and agents stay.
- `local/down.sh --reset` also deletes all of it, to start over from this lab.
  It removes the stacks' volumes, the engine's keys in `.lab/ork`, your local
  `.env`, and the ids in `.orca-state/`. The engine's volumes and its keys have
  to go together: with only one of them deleted, the engine cannot start again.

## Recap

- Two stacks run on your laptop: the streaming stack (one Compose file) and the
  Agent Engine (`ork local`, through `local/engine.sh`).
- The login topic is diskless: its records are objects, written through Ursa.
- `.env` says `TUTORIAL_STACK=local`, and the doctor checks every part.

## What's next

[Lab 1: Hello, agent](01-hello-agent.md)
