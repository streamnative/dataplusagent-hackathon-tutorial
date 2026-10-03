# Lab 0: Set up

**Cloud course** · 3 minutes, plus 5 on your own · CLI, Python, or TypeScript

You put your team card in `.env` and run the doctor. When this lab is done, you
know that the Agent Engine, Kafka, and Schema Registry on your card all answer.

## Before you start

- You have your **team card** from the organizers.
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
above too: the doctor and the data injector come from one of them.

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

## Step 2: Paste your team card

Open a second terminal at the repository root. Copy the template, then paste the
values from your team card into `.env`:

```bash
cp .env.cloud.example .env
```

`.env` is git-ignored. It holds your team's key: do not commit it or paste it
anywhere.

`SN_API_KEY` authenticates the hosted Agent Engine, Kafka, and Schema Registry.
The MCP server uses a separate browser login, in Lab 3: keep `SN_MCP_AUTH=oauth`
and leave `SN_MCP_OAUTH_ISSUER` empty.

### Check

One authenticated read of your Agent Engine. It prints `true` when the endpoint
and the key on your card are accepted.

```bash
./lab-ork agent list -o json | jq -e 'has("data")'
```

Before you filled in `.env`, the same command says
`Missing ORCA_BASE_URL, SN_API_KEY` instead: the two values it needs.

## Step 3: Run the doctor

In your path's folder:

| Python | TypeScript | CLI |
|---|---|---|
| `python doctor.py` | `npm run doctor` | `(cd ../python && .venv/bin/python doctor.py)` or `(cd ../typescript && npm run doctor)` |

The doctor checks your laptop, then each service on your card. A failed check
prints its fix on the next line. After the lines from step 1, it prints:

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

### Check

The last line of the doctor says you are ready, and no line says `FAIL`.

```bash
(cd python && .venv/bin/python doctor.py) | tail -n 1
```

On the TypeScript path, use `npm --prefix typescript run doctor | tail -n 1`.

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

**2. What does `./lab-ork` add to `ork`?**

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

- `.env` in the repository root is your team card. It is git-ignored.
- The doctor checks each service on the card and prints the fix for a failure.
- `./lab-ork` is how you look at your Agent Engine from the terminal.

## What's next

[Lab 1: Hello, agent](01-hello-agent.md)
