# The labs

Two courses teach the same five labs on two stacks. Pick one.

| | [Cloud course](cloud/README.md) | [Local course](local/README.md) |
|---|---|---|
| Runs on | StreamNative Cloud: your team's Kafka cluster, SQL Workspace, and a hosted Agent Engine | Your laptop: Ursa for Kafka, RisingWave, and the Orca Agent Engine |
| You need | A team card, handed out at the hackathon | Docker and an Anthropic API key |
| Time | About 30 minutes | About 45 minutes, plus the image downloads |
| Take it when | You are at the event | You have no team card, or you want to see every part run |

Both courses use the same three paths for the agent steps. Pick one path and stay
on it; a teammate can pick another.

- **CLI**: the [`ork`](https://github.com/orca-ae/orca-cli) command line
- **Python**: the [`runorca`](https://pypi.org/project/runorca/) SDK
- **TypeScript**: the [`@runorca/orca-sdk`](https://www.npmjs.com/package/@runorca/orca-sdk) SDK

## The labs

| Lab | You | The idea |
|---|---|---|
| 0. Set up | Get your stack ready and run the doctor | Know that every part answers before you build on it |
| 1. Hello, agent | Create an agent and talk to it | Agent, environment, session, events |
| 2. Hello, streaming SQL | Build a materialized view over the login topic | Context that keeps itself fresh |
| 3. Agent + live context | Give the agent SQL tools, then inject new data | The answer changes with the data |
| 4. Agent acts, human approves | Let the agent write, with your OK | Governed actions |

The labs build on each other, so take them in order.

## How a lab works

Every lab has the same parts, in the same order.

1. **Before you start** says what has to be true first.
2. **Three or four steps.** Each step has you do one thing, then explains what
   happened. Each step ends in a **Check**.
3. **Check your understanding**: two or three questions. The answer is folded
   under each one; decide first, then open it.
4. **Try it yourself**: a small task with no instructions, its own check, and a
   folded solution.
5. **Recap** and **What's next**.

In a guided session the steps are what you do together. The questions and the
task are yours to do afterwards.

## How to check your work

A check is a command that reads something and changes nothing. Before you do a
step, its check prints nothing, or says what is missing. After the step, it
prints the evidence.

Most checks look like this:

```bash
./lab-ork agent get @agent_id -o json | jq -e '{name, version}'
```

- [`./lab-ork`](../lab-ork) is `ork`, pointed at your Agent Engine with the key
  from your `.env`. It replaces `@agent_id`, `@environment_id`, `@vault_id` and
  `@session_id` with the ids your lab scripts saved in `.orca-state/`, so you
  never copy an id by hand.
- `jq -e` prints what the filter selects, and exits non-zero when it selects
  nothing. A check passes when it prints something.

The other checks are SQL: a `SELECT` that returns a row once the step is done.

Keep two terminals open. Run the steps in your path's folder (`cli/`, `python/`
or `typescript/`), and run the checks from the repository root.

## Learn with a tutor

If you use a coding agent such as Claude Code, it can walk you through a course
one step at a time, check your work with you, and quiz you. See
[Learn with the tutor](../docs/tutor.md).
