# Lab 1: Hello, agent

**Local course** · 5 minutes, plus 5 on your own · CLI, Python, or TypeScript

You create an agent with no tools, start a conversation, and read back what the
Agent Engine recorded. When this lab is done, you have an agent at version 1 and
you know the four things every later lab reuses: environment, agent, session,
events.

## Before you start

- You finished [Lab 0](00-set-up.md): the doctor says you are ready.
- One terminal is in your path's folder (`cli/`, `python/` with the virtual
  environment active, or `typescript/`). A second one is at the repository root.

## Step 1: Create your agent and say hello

In your path's folder:

| CLI | Python | TypeScript |
|---|---|---|
| `./l1_hello.sh` | `python l1_hello.py` | `npm run l1` |

You see something like this. The agent's wording varies, and it writes Markdown,
which your terminal shows as it is.

```text
hello-agent-ana v1: no tools: just a conversation
[you]    Hi! What is the Data + Agent Hackathon, and what can you see right now?
[agent]  # Welcome to the Data + Agent Hackathon! 🎉

The **Data + Agent Hackathon** is a hands-on competition at the **Data Streaming Summit 2026** where participants build intelligent agents that combine real-time data streaming with AI ...

As for what I can see right now — nothing live just yet! The next step connects me to a **live Kafka stream through streaming SQL**, which is where the real-time magic happens. Stay tuned! 🚀
```

This is the first time your stack calls the model. If you see
`[error]  ... (retrying)` lines and no reply, the model provider rejected the key
the engine started with: press Ctrl-C and see
[Troubleshooting](troubleshooting.md#the-model-does-not-answer).

### Check

Read your agent back. It prints the name, the version, and that it has no tools.

```bash
./lab-ork agent get @agent_id -o json | jq -e '{name, version, tools: (.tools | length)} | select(.tools == 0)'
```

```json
{
  "name": "hello-agent-ana",
  "version": 1,
  "tools": 0
}
```

Before the step, the same command says `No agent_id yet`: nothing has been
created.

**What just happened: four API calls.**

1. **Environment**: where your agent's sessions run.
2. **Agent**: a model plus a system prompt, defined in
   [`agent/local/l1-hello.json`](../../agent/local/l1-hello.json). All three
   paths read that file.
3. **Session**: one conversation, pinned to a specific agent version.
4. **Events**: you send a `user.message`; the agent streams back `agent.message`
   events until the session goes idle.

<details>
<summary>The code (Python)</summary>

```python
environment_id = ensure_environment(client, state, f"hello-env-{config.participant}")

layer = load_layer("l1-hello", config.stack)
agent = ensure_agent(client, state, agent_params(layer, config))

session = open_session(client, state, environment_id, agent, "L1: hello")
run_turn(client, session.id, question, send_first=config.stack == "local")
```

`open_session` ([`python/common.py`](../../python/common.py)) is one call,
`client.sessions.create(environment_id=..., agent={"type": "agent", "id": agent.id, "version": agent.version}, title=...)`,
and it remembers the session id for your checks. `run_turn` prints events until
the agent's turn ends. With `send_first`, it sends the message and then follows
the session's event stream from its start, so nothing the agent says in between
is missed. The engine on your laptop needs that order: it answers a stream
opened on a quiet session only at its next keep-alive, 15 seconds later.
</details>

<details>
<summary>The code (TypeScript)</summary>

```ts
const environmentId = await ensureEnvironment(client, state, `hello-env-${config.participant}`);

const layer = loadLayer('l1-hello', config.stack);
const agent = await ensureAgent(client, state, agentParams(layer, config));

const session = await openSession(client, state, environmentId, agent, 'L1: hello');
await runTurn(client, session.id, question, { sendFirst: config.stack === 'local' });
```

`openSession` and `runTurn` ([`typescript/src/common.ts`](../../typescript/src/common.ts))
work the same way as the Python versions.
</details>

<details>
<summary>The commands (CLI)</summary>

```bash
ork agent environments create --name hello-env-ana -o json

ork agent create --name hello-agent-ana --model "$ORCA_MODEL" \
  --system "$(jq -r .system ../agent/local/l1-hello.json)" -o json

ork agent sessions create --agent <agent id> --agent-version 1 \
  --environment-id <environment id> --title "L1: hello" -o json

ork agent sessions events send message --session <session id> --text "Hi! ..."
ork agent sessions events stream --session <session id> --timeout 15s
```

[`cli/lib.sh`](../../cli/lib.sh) wraps these commands, remembers the ids, and
prints the stream the same way as the other paths.
</details>

## Step 2: Read the conversation back

A session is a list of events. From the repository root, list the types of the
events in the conversation you just had, oldest first:

```bash
./lab-ork agent sessions events list --session @session_id --order asc -o json | jq -r '.data[].type'
```

```text
user.message
session.status_running
span.model_request_start
agent.thinking
agent.message
span.model_request_end
session.status_idle
```

Your message, the agent's reply, and the event that ends the turn. The `span.`
events time the model request, and `agent.thinking` is the model working out its
answer before it gives it.

### Check

"The agent replied" is three facts together: the turn ended normally, and a
reply came after your message. This prints the reply when all three hold.

```bash
./lab-ork agent sessions events list --session @session_id --order asc --limit 200 -o json | jq -e '
  .data
  | select((map(select(.type == "session.status_idle")) | last | .stop_reason.type) == "end_turn")
  | .[(map(.type) | rindex("user.message")):]
  | map(select(.type == "agent.message")) | last
  | select(. != null)
  | {reply: .content[0].text}'
```

Reading it line by line: take the events; keep going only if the last idle event
stopped for `end_turn`; look at what came after your last message; take the last
`agent.message` there; print its text. A turn that ended for another reason, or
ended without a reply, prints nothing.

## Step 3: Run it again

Ask your own question this time:

| CLI | Python | TypeScript |
|---|---|---|
| `./l1_hello.sh "What will you be able to do in Lab 3?"` | `python l1_hello.py "What will you be able to do in Lab 3?"` | `npm run l1 -- "What will you be able to do in Lab 3?"` |

The first line still says `v1`. Re-running is safe: the scripts remember your
agent in `.orca-state/`, and only create a new version when its definition
changes. The conversation is new; the agent is not.

### Check

Your agent now has two sessions, and both are pinned to version 1. It prints
them once there are two.

```bash
./lab-ork agent sessions list --agent @agent_id -o json | jq -e '[.data[] | {title, version: .agent.version}] | select(length >= 2)'
```

```json
[
  {
    "title": "L1: hello",
    "version": 1
  },
  {
    "title": "L1: hello",
    "version": 1
  }
]
```

## Check your understanding

**1. What ties a session to one definition of the agent?**

- A. The agent's name
- B. The agent version the session was created with
- C. The environment

<details>
<summary>Answer</summary>

**B.** A session records the agent id *and* version. Changing the agent later
creates a new version and does not touch a conversation that is already running.

</details>

**2. You run the script twice without changing anything. How many agents and versions exist?**

- A. Two agents
- B. One agent, at version 2
- C. One agent, at version 1

<details>
<summary>Answer</summary>

**C.** The script stores a fingerprint of the definition in the agent's
metadata. Same fingerprint, no update. Each run does start a new session.

</details>

**3. Which event tells you the agent's turn is over?**

- A. `agent.message`
- B. `session.status_idle`
- C. `user.message`

<details>
<summary>Answer</summary>

**B.** It carries a `stop_reason`. `end_turn` means the turn finished normally;
in Lab 4 you will see `requires_action`, which means the session is waiting for
you.

</details>

## Try it yourself

Change how your agent talks, and watch its version change. Make it answer in a
single sentence, run the lab script again, then confirm the agent is at a newer
version.

### Check

It prints the version once it is 2 or more.

```bash
./lab-ork agent get @agent_id -o json | jq -e 'select(.version >= 2) | {name, version}'
```

<details>
<summary>Solution</summary>

The agent is the JSON file. In
[`agent/local/l1-hello.json`](../../agent/local/l1-hello.json), change
"Answer in two or three sentences." to "Answer in one sentence.", then run the
Lab 1 script again. The first line now says `v2`.

Put the file back before the next lab (`git checkout agent/local/l1-hello.json`).
Your version numbers will run one or two ahead of the ones the labs show. That is
fine: the checks never depend on an exact number after this lab.

On the CLI path, do this before Lab 3. Once your agent has tools, `ork` cannot
take them away, so going back to Lab 1 starts a fresh agent at version 1, and the
script says so.

</details>

## Recap

- An agent is configuration: a model, a system prompt, and (later) tools.
- Every change to it is a new version. A session is pinned to one version.
- A conversation is a list of events, and `session.status_idle` ends a turn.

## What's next

[Lab 2: Hello, streaming SQL](02-streaming-sql.md)
