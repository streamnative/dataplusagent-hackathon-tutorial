# Learn with the tutor

The repository ships a tutor: a skill for coding agents such as Claude Code. It
walks you through a course one step at a time, looks at each check with you, and
quizzes you. It reads the lab pages in [`labs/`](../labs/README.md) from your
clone, so it teaches what the pages say.

## What it does, and what it will not do

- It gives you **one step**, with the command to run and the step's check. You
  run both in your own terminal and paste what the check printed. That is how it
  knows a step worked.
- It starts a lab with the page's "Before you start" list, and ends it with the
  page's "Clean up".
- When a check prints nothing, or you paste an error, it looks the symptom up in
  the course's troubleshooting page and gives you that fix.
- It **does not run the lab for you**. Your terminal has your folder, your
  virtual environment, and your keys. The agent's shell has none of them, and a
  step you did not run is a step you did not learn.
- It **does not read your keys**. It never opens `.env` or `.lab/`, and it does
  not need them: the doctor says `PASS` or `FAIL` for each part of your setup
  and does not print a key. Do not paste a key into the chat. In Claude Code
  started at the root of the clone, a project setting
  ([`.claude/settings.json`](../.claude/settings.json)) also denies the agent's
  file-reading tool those files, whatever it was asked. That is a guard rail,
  not a lock: it does not cover every program an agent can run, and it does not
  apply when Claude Code is started in a subfolder.
- It **does not give a quiz answer before you pick one**, or a solution before
  you have tried. It gives hints instead, up to three. You can always skip: the
  questions and the "Try it yourself" task are optional, and the answers are
  folded in the lab page.

## Start it

Open your coding agent **in your clone of this repository**, at its root. There
is nothing to install.

| Agent | How to start the tutor |
|---|---|
| Claude Code | Type `/data-agent-tutor`, or ask: `Tutor me through the Local course.` |
| Codex CLI, Gemini CLI | Ask: `Tutor me through the Local course.` Both find the skill in `.agents/skills/`. |
| Any other agent | Say: `Read skills/data-agent-tutor/SKILL.md and follow it. Tutor me through the Local course.` |

What was tried: lessons were run in Claude Code (2.1.287). For Codex CLI
(0.147.0) and Gemini CLI (0.34.0) the check was that each lists the skill; no
lesson was run in them. If yours does not pick the skill up, the sentence in the
last row works in any agent that can read a file.

Started with no request, the tutor asks three things:

```text
1. Course: Cloud (on StreamNative Cloud, with a team card from the organizers or with your own instance: say which) or Local (everything on your laptop)?
2. Path: CLI, Python, or TypeScript?
3. What now: start at Lab 0, resume at a lab, quiz me on a lab, or check my setup?
```

## What to say to it

| You want to | Say |
|---|---|
| Take a course from the start | `Start the Cloud course on the Python path.` |
| Start from a team card | `Start the Cloud course on the Python path. I have a team card.` |
| Pick up where you stopped | `Resume the Local course at Lab 3. I'm on TypeScript.` |
| Be quizzed | `Quiz me on Lab 2.` |
| Find out why something fails | `Check my setup.` Or paste the error. |
| Get unstuck on a task | `Give me a hint.` |
| Move on | `Skip this.` |

After each step, paste what its check printed. A check that prints the evidence
means the step worked. A check that prints nothing means it has not, and the
tutor takes it from there.

## What it looks like

This is from a real session, shortened. It was recorded before the tutor put a
lab's "Before you start" list above the first step it sends:

```text
You:    Local. I'm on the CLI path. Resume at Lab 2.

Tutor:  Lab 2, step 1 of 3: Connect RisingWave to the topic

        In the terminal at the repository root.

        Run:
          local/sql.sh < sql/local/00_source.sql
          local/sql.sh < sql/local/01_explore.sql

        Check:
          local/sql.sh -tA -c 'SELECT count(*) FROM "security.login_events"'
        This prints 246, the number of logins the seeder loaded.

        Run both, then paste what the check printed.

You:    246

Tutor:  246 matches the page: the source reads the whole topic, and that is the
        number of logins the seeder loaded. ...

        Lab 2, step 2 of 3: Turn the stream into context ...

You:    (an error) can you just run it on your side and see what's wrong?

Tutor:  I don't run the lab's commands, not even just to look: the steps are
        yours, and your terminal is the one that counts. We also don't need it,
        because the error you pasted already says what is wrong. ...
```

## If the tutor does not show up

- **Check where the agent was started.** It has to be in your clone, in the
  folder that holds `labs/`. Start it there again.
- **Update your clone.** `git pull`, then start the agent again: agents read
  their skills when they start.
- **On Windows, clone inside WSL.** The skill is linked into `.claude/skills/`
  and `.agents/skills/`. Git for Windows can check such links out as small text
  files, and then the agent does not find the skill. This was not tried here;
  the next sentence works either way.
- **Use the sentence that always works.** Tell the agent:
  `Read skills/data-agent-tutor/SKILL.md and follow it.` Any agent that can read
  a file can be the tutor.

## Install it for your user account (optional)

You do not need this inside the clone. It makes the skill available to an agent
that reads its skills only from your home directory. The tutor still has to be
started in the clone, because that is where the lab pages are.

With the [`skills`](https://github.com/vercel-labs/skills) CLI, at the root of
your clone:

```bash
npx skills add "$PWD" --skill data-agent-tutor --agent claude-code --global -y
```

This copies the skill to `~/.claude/skills/data-agent-tutor/`. For another
agent, change `--agent` (`npx skills --help` describes the options). Keep
`--global`: without it, the CLI installs into the current folder, and inside the
clone that replaces the skill links the repository ships.

Two more ways take the repository from GitHub instead of your clone. They follow
the `skills` CLI's and Claude Code's documentation, and were not run when this
page was written:

```bash
npx skills add streamnative/dataplusagent-hackathon-tutorial --skill data-agent-tutor --global
```

```text
/plugin marketplace add streamnative/dataplusagent-hackathon-tutorial
/plugin install data-agent-tutor@dataplusagent-hackathon-tutorial
```
