# Troubleshooting: Local course

Two commands tell you what is wrong. Run both first.

```bash
local/engine.sh --check                    # the Agent Engine, and its link to the MCP server
(cd python && .venv/bin/python doctor.py)  # or: npm --prefix typescript run doctor
```

Each failed line prints its fix.

## Symptoms

| Symptom | Fix |
|---|---|
| `docker compose ... up` fails with a port already in use | Another program has one of the ports the stack publishes on `127.0.0.1`: 29092 (Kafka), 18081 (schema registry), 4566 and 5691 (RisingWave), 8000 (MCP). Stop that program. The ports are fixed: the broker tells its clients to come back to `127.0.0.1:29092`, and `local/write-env.sh` writes these ports into `.env`. |
| `local/engine.sh` fails because port 8080 is taken (`Bind for 0.0.0.0:8080 failed: port is already allocated`) | Pick another port for the registry: `export ORCA_LOCAL_REGISTRY_PORT=18080`, run `local/engine.sh` again, then `local/write-env.sh` so `.env` has the new address. Export it in every terminal you run `local/engine.sh` from: a run without it goes back to 8080. |
| `local/engine.sh`: `ANTHROPIC_API_KEY is not set in this shell` | `export ANTHROPIC_API_KEY=<your key>` in the terminal where you run the script. The engine reads the key only when it starts. |
| `local/engine.sh`: `bootstrap refused: an organization already exists` | The engine's volumes exist but its keys in `.lab/ork` are gone. Start over: `local/down.sh --reset`, then Lab 0. |
| Doctor: `Agent Engine HTTP 401` | The key in `.env` is not the running engine's key. Run `local/write-env.sh`. If it still fails, the engine's volumes and keys are out of step: `local/down.sh --reset`, then Lab 0. |
| Doctor: `Kafka ... not found` | The topic does not exist yet: Lab 0, step 4. |
| Doctor: `Schema Registry ... not found` | The schema is registered when you seed the topic: `python seed.py` or `npm run seed`. |
| Doctor: `Kafka`, `Schema Registry`, or `MCP server` cannot be reached, or `RisingWave through MCP` fails | The streaming stack is not up: `docker compose -f local/compose.yaml up -d --wait`. |
| Doctor: `Agent Engine   Connection error` | The engine is not up: `local/engine.sh`. Start the streaming stack first. |
| `seed`: `already holds 246 events` | The topic is seeded. Nothing to do. |
| `table or source not found: security.login_events` | Create the source: Lab 2, step 1. |
| `table or source not found: login_failures` or `flagged_accounts` | Create the view or the table: Lab 2, steps 2 and 3. |
| Lab 3: the agent's tool call fails, or the script prints `[error]` lines about MCP or `egress denied` | The gateway lost its link to the MCP server, which happens whenever the engine restarts. Run `local/engine.sh`, then the lab script again. |
| The agent answers from memory instead of querying | Ask again, "check the view first". The system prompt tells it to always query. |
| `./lab-ork` says `No session_id yet` | The lab step that creates it has not run on this stack. Run the lab's script first. |
| A script seems stuck at an approval | The session is waiting for you. Answer the `Allow it? [y/N]` prompt, or press Ctrl-C and run the lab script again: it starts a fresh session. |

## The model does not answer

Lab 1 is the first time the stack calls the model. If the script prints lines
like this and no `[agent]` reply:

```text
[error]  server_error (status 502) (retrying)
```

the model provider rejected the request, and the engine retries for about three
minutes before it gives up. Its last line then names the provider's answer. For
a key the provider does not accept, that is:

```text
The agent stopped (retries_exhausted): API Error: 502 bad gateway: ... upstream returned 401: ... "API key is invalid." ...
```

You do not have to wait for it: press Ctrl-C. That stops your script, not the
engine. The engine keeps retrying that turn for the rest of the three minutes,
and a turn you start meanwhile waits behind it. The usual cause is the key:

1. Check that the key works at all, for example in the
   [Anthropic console](https://console.anthropic.com/).
2. Export the working key and restart the engine, which reads the key only at
   start:

   ```bash
   export ANTHROPIC_API_KEY=<your key>
   local/engine.sh
   ```

3. Run the lab script again.

If the key is fine, check that `ORCA_MODEL` in `.env` is a model your key can
use.

## Start over

```bash
local/down.sh --reset
```

This stops both stacks and deletes their volumes, the engine's keys in
`.lab/ork`, your local `.env`, and the ids in `.orca-state/`. Then start again at
[Lab 0](00-set-up.md). The image downloads are kept, so it is quick.

To start over only part of the way:

- **Lab 2 only**: `local/sql.sh < sql/local/99_reset.sql` drops the view, the
  table, and the source. The topic and its events stay.
- **Your agent only**: run the cleanup script of your path (`./cleanup.sh`,
  `python cleanup.py`, or `npm run cleanup`). The next lab script creates a new
  agent.

## What is running

```bash
docker compose -f local/compose.yaml ps        # the streaming stack
ork local --data-dir "$PWD/.lab/ork" status    # the Agent Engine
docker compose -f local/compose.yaml logs risingwave-mcp --tail 20
```

Run them at the repository root. `ork` v0.6.0 needs the data directory as a full
path, which is what `"$PWD/.lab/ork"` gives it there.

RisingWave has a dashboard at <http://127.0.0.1:5691>.
