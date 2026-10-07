#!/usr/bin/env bash
# Tests for scripts/check-labs.sh: each rule, on small labs written here.
#
#   scripts/tests/run.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
CHECK="$(dirname "$TESTS")/check-labs.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/hello-lab-tests.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

PASSED=0
FAILED=0
R=""
STATUS=0

# ------------------------------------------------------------------ helpers --

fresh_root() {  # fresh_root <name>: an empty repo with a README
  R="$WORK/$1"
  mkdir -p "$R/labs/cloud" "$R/docs"
  echo "# Repo" >"$R/README.md"
}

good_lab() {  # a lab that follows every rule
  cat <<'EOF'
# Lab 1: Hello, agent

**Cloud course** · 5 minutes, plus 5 on your own · CLI, Python, or TypeScript

You create an agent and it answers.

## Before you start

- You finished [Lab 0](00-set-up.md).

## Step 1: Run it

```bash
python l1_hello.py
```

### Check

It prints the agent's name.

```bash
./lab-ork agent get @agent_id -o json | jq -e '{name}'
```

## Step 2: Read it back

Look at the events.

### Check

```bash
./lab-ork agent sessions events list --session @session_id -o json | jq -e '.data[0]'
```

## Step 3: Run it again

Nothing new is created.

### Check

```bash
./lab-ork agent get @agent_id -o json | jq -e 'select(.version == 1)'
```

## Check your understanding

**1. What pins a session to a definition?**

- A. The agent's name
- B. The agent's version
- C. The environment

<details>
<summary>Answer</summary>

**B.** A session records the version it started with.

</details>

**2. What ends a turn?**

- A. `session.status_idle`
- B. `agent.message`
- C. Nothing

<details>
<summary>Answer</summary>

**A.** The idle event carries the stop reason.

</details>

## Try it yourself

Change the prompt and run it again.

### Check

```bash
./lab-ork agent get @agent_id -o json | jq -e 'select(.version >= 2)'
```

<details>
<summary>Solution</summary>

Edit the JSON, then rerun.

</details>

## Recap

- An agent is configuration.

## What's next

[Lab 2](02-streaming-sql.md)
EOF
}

lab() {  # lab <file name> [sed expression to break the good lab]
  good_lab | sed "${2:-}" >"$R/labs/cloud/$1"
}

lint() {
  if "$CHECK" "$R" >"$R/out" 2>"$R/err"; then STATUS=0; else STATUS=$?; fi
}

says() { grep -qF -- "$1" "$R/out"; }

check() {  # check <description> <command...>
  if "${@:2}"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL  %s\n' "$1"
    printf -- '--- stdout\n'; cat "$R/out" 2>/dev/null || true
    printf -- '--- stderr\n'; cat "$R/err" 2>/dev/null || true
  fi
}

two_labs() {  # the good lab plus the two pages it links to
  lab 01-hello-agent.md
  lab 00-set-up.md 's/^# Lab 1: Hello, agent/# Lab 0: Set up/'
  lab 02-streaming-sql.md 's/^# Lab 1: Hello, agent/# Lab 2: Streaming SQL/'
}

# -------------------------------------------------------------------- tests --

test_a_lab_that_follows_the_rules_passes() {
  fresh_root good
  two_labs
  lint
  check "a well-formed course passes" [ "$STATUS" -eq 0 ]
  check "and reports nothing" [ ! -s "$R/out" ]
}

test_a_step_without_a_check_fails() {
  fresh_root no-check
  two_labs
  # Drop the first "### Check" heading, which belongs to Step 1.
  awk '!done && /^### Check$/ { done = 1; next } { print }' "$R/labs/cloud/01-hello-agent.md" >"$R/tmp" && mv "$R/tmp" "$R/labs/cloud/01-hello-agent.md"
  lint
  check "a step with no check fails" [ "$STATUS" -eq 1 ]
  check "naming the file and the step" says "labs/cloud/01-hello-agent.md"
  check "and what is wrong" says "Step 1: Run it has 0 checks; every step needs exactly one"
}

test_a_check_without_a_command_fails() {
  fresh_root empty-check
  two_labs
  # Remove the fenced command under Step 2's check (the fence and its one line).
  awk '/^## Step 2/ { s2 = 1 } /^## Step 3/ { s2 = 0 } s2 && /^```/ { next } s2 && /lab-ork/ { next } { print }' \
    "$R/labs/cloud/01-hello-agent.md" >"$R/tmp" && mv "$R/tmp" "$R/labs/cloud/01-hello-agent.md"
  lint
  check "a check with no command fails" [ "$STATUS" -eq 1 ]
  check "and says so" says "the check has no command"
}

test_sections_out_of_order_fail() {
  fresh_root order
  two_labs
  lab 01-hello-agent.md 's/^## Recap$/## Recap moved/; s/^## Try it yourself$/## Recap/; s/^## Recap moved$/## Try it yourself/'
  lint
  check "sections out of order fail" [ "$STATUS" -eq 1 ]
  check "and the expected order is named" says "sections must come in this order"
}

test_too_few_steps_fail() {
  fresh_root steps
  two_labs
  awk '/^## Step 3/ { skip = 1 } /^## Check your understanding/ { skip = 0 } !skip { print }' \
    "$R/labs/cloud/01-hello-agent.md" >"$R/tmp" && mv "$R/tmp" "$R/labs/cloud/01-hello-agent.md"
  lint
  check "two steps are too few" [ "$STATUS" -eq 1 ]
  check "and the count is reported" says "has 2 steps; a lab has three or four"
}

test_a_quiz_question_without_an_answer_fails() {
  fresh_root quiz
  two_labs
  awk '!done && /<summary>Answer<\/summary>/ { done = 1; sub(/Answer/, "Hint") } { print }' \
    "$R/labs/cloud/01-hello-agent.md" >"$R/tmp" && mv "$R/tmp" "$R/labs/cloud/01-hello-agent.md"
  lint
  check "a question without an answer fails" [ "$STATUS" -eq 1 ]
  check "and the counts are reported" says "2 questions but 1 answers"
}

test_try_it_yourself_needs_a_solution() {
  fresh_root solution
  two_labs
  lab 01-hello-agent.md 's/<summary>Solution<\/summary>/<summary>Hint<\/summary>/'
  lint
  check "try-it-yourself without a solution fails" [ "$STATUS" -eq 1 ]
  check "and says so" says "Try it yourself needs exactly one check and one solution"
}

test_a_lab_needs_its_title_and_header_line() {
  fresh_root header
  two_labs
  lab 01-hello-agent.md 's/^\*\*Cloud course\*\*.*$/Five minutes./'
  lint
  check "a lab without its header line fails" [ "$STATUS" -eq 1 ]
  check "and says what the header line is" says "course, minutes, and paths"
}

test_a_broken_relative_link_fails() {
  fresh_root links
  two_labs
  echo "See [the tutor](docs/tutor.md) and [a lab](labs/cloud/01-hello-agent.md#step-1-run-it) and [the web](https://example.com/x)." >>"$R/README.md"
  lint
  check "a link to a missing file fails" [ "$STATUS" -eq 1 ]
  check "naming the file and the target" says "README.md"
  check "and the missing target" says "docs/tutor.md"
  echo "# Tutor" >"$R/docs/tutor.md"
  lint
  check "it passes once the target exists; anchors and web links are not checked" [ "$STATUS" -eq 0 ]
}

test_headings_inside_code_fences_are_not_sections() {
  fresh_root fences
  two_labs
  awk '/^python l1_hello.py$/ { print; print "## Not a section"; print "### Check"; next } { print }' \
    "$R/labs/cloud/01-hello-agent.md" >"$R/tmp" && mv "$R/tmp" "$R/labs/cloud/01-hello-agent.md"
  lint
  check "headings inside a code fence are ignored" [ "$STATUS" -eq 0 ]
}

test_the_tutor_skill_names_only_lab_pages_that_exist() {
  fresh_root tutor
  two_labs
  mkdir -p "$R/labs/local" "$R/skills/data-agent-tutor"
  cp "$R"/labs/cloud/*.md "$R/labs/local/"
  echo "# Troubleshooting" >"$R/labs/cloud/troubleshooting.md"
  # shellcheck disable=SC2016  # the backticks are Markdown, not a command
  printf 'The pages: `00-set-up.md` · `01-hello-agent.md` · `troubleshooting.md`\n' >"$R/skills/data-agent-tutor/SKILL.md"
  lint
  check "a lab page the tutor names but a course lacks fails" [ "$STATUS" -eq 1 ]
  check "naming the page and the course" says "skills/data-agent-tutor/SKILL.md names troubleshooting.md, but labs/local/troubleshooting.md does not exist"
  echo "# Troubleshooting" >"$R/labs/local/troubleshooting.md"
  lint
  check "it passes once both courses have every page the tutor names" [ "$STATUS" -eq 0 ]
}

test_the_tutor_skill_can_name_a_page_only_one_course_has() {
  fresh_root tutor-one-course
  two_labs
  mkdir -p "$R/labs/local" "$R/skills/data-agent-tutor"
  cp "$R"/labs/cloud/*.md "$R/labs/local/"
  # shellcheck disable=SC2016  # the backticks are Markdown, not a command
  printf 'Both courses: `00-set-up.md`. Cloud only: `labs/cloud/00-set-up-team-card.md`.\n' >"$R/skills/data-agent-tutor/SKILL.md"
  lint
  check "a page the tutor names with its course folder fails while it is missing" [ "$STATUS" -eq 1 ]
  check "naming the skill and the page" says "skills/data-agent-tutor/SKILL.md names labs/cloud/00-set-up-team-card.md"
  lab 00-set-up-team-card.md 's/^# Lab 1: Hello, agent/# Lab 0: Set up from a team card/'
  lint
  check "it passes once that course has the page; the other course does not need one" [ "$STATUS" -eq 0 ]
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do "$t"; done

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
