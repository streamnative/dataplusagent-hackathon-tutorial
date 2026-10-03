#!/usr/bin/env bash
# Check that every lab has the shape the courses promise, and that links resolve.
#
#   scripts/check-labs.sh [repo root]
#
# A lab is labs/<course>/NN-<name>.md. Its sections, in this order:
#
#   # Lab N: <title>
#   **<Cloud|Local> course** · <minutes> · <paths>
#   ## Before you start
#   ## Step 1: ...   (three or four steps, each with exactly one "### Check"
#                     that holds at least one command)
#   ## Check your understanding   (two or three "**N. ...**" questions, each
#                                  with an <summary>Answer</summary>)
#   ## Try it yourself            (one "### Check", one <summary>Solution</summary>)
#   ## Clean up                   (optional)
#   ## Recap
#   ## What's next
#
# Relative links are checked in README.md, labs/, docs/ and skills/. The lab
# pages the tutor skill names have to exist in both courses.
# Prints one line per problem and exits 1 if there is any.
set -euo pipefail

ROOT=$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd)
cd "$ROOT"

problems=$(mktemp "${TMPDIR:-/tmp}/check-labs.XXXXXX")
trap 'rm -f "$problems"' EXIT

# ------------------------------------------------------------ lab structure --

lint_lab() {  # lint_lab <file>
  awk -v file="$1" '
    function problem(message) { printf "%s: %s\n", file, message }
    function close_section() {
      if (section ~ /^Step [0-9]+: /) {
        if (checks != 1) problem(section " has " checks " checks; every step needs exactly one")
        else if (commands == 0) problem(section ": the check has no command")
      }
      if (section == "Try it yourself") {
        if (checks != 1 || solutions != 1) problem("Try it yourself needs exactly one check and one solution")
        else if (commands == 0) problem("Try it yourself: the check has no command")
      }
      if (section == "Check your understanding") {
        if (questions < 2 || questions > 3) problem("Check your understanding has " questions " questions; a lab has two or three")
        if (questions != answers) problem("Check your understanding has " questions " questions but " answers " answers")
      }
    }
    BEGIN { fence = 0; steps = 0; order = "" }
    /^```/ {
      fence = !fence
      if (fence && in_check) commands++
      next
    }
    fence { next }
    NR == 1 && $0 !~ /^# Lab [0-9]+: ./ { problem("the first line must be \"# Lab N: <title>\"") }
    /^\*\*(Cloud|Local) course\*\* · .*minutes.* · ./ { header = 1 }
    /^## / {
      close_section()
      section = substr($0, 4)
      checks = 0; commands = 0; solutions = 0; questions = 0; answers = 0; in_check = 0
      if (section ~ /^Step [0-9]+: ./) {
        steps++
        if (section !~ ("^Step " steps ": ")) problem("\"" section "\" should be Step " steps)
        name = "Step"
      } else name = section
      if (name != last) order = order (order == "" ? "" : " > ") name
      last = name
      next
    }
    /^### Check$/ { checks++; in_check = 1; next }
    /^### / { in_check = 0 }
    /<summary>Solution<\/summary>/ { solutions++; in_check = 0 }
    /<summary>Answer<\/summary>/ { answers++ }
    section == "Check your understanding" && /^\*\*[0-9]+\. / { questions++ }
    END {
      close_section()
      if (!header) problem("line 3 must name the course, minutes, and paths: \"**Cloud course** · 5 minutes · CLI, Python, or TypeScript\"")
      if (steps < 3 || steps > 4) problem("has " steps " steps; a lab has three or four")
      with = "Before you start > Step > Check your understanding > Try it yourself > Clean up > Recap > What'"'"'s next"
      without = "Before you start > Step > Check your understanding > Try it yourself > Recap > What'"'"'s next"
      if (order != with && order != without) problem("sections must come in this order: " with " (Clean up is optional); found: " order)
    }
  ' "$1"
}

for lab in labs/*/[0-9][0-9]-*.md; do
  [ -f "$lab" ] || continue
  lint_lab "$lab" >>"$problems"
done

# -------------------------------------------------------------------- links --

# Every relative link target in a Markdown file, one per line, outside code fences.
link_targets() {  # link_targets <file>
  awk '
    /^```/ { fence = !fence; next }
    fence { next }
    {
      line = $0
      while (match(line, /\]\([^)]+\)/)) {
        target = substr(line, RSTART + 2, RLENGTH - 3)
        line = substr(line, RSTART + RLENGTH)
        sub(/[ \t]+"[^"]*"$/, "", target)   # drop a link title
        if (target ~ /^(https?:|mailto:|#)/) continue
        sub(/#.*$/, "", target)
        if (target != "") print target
      }
    }
  ' "$1"
}

check_links() {  # check_links <file>
  local file=$1 dir target
  dir=$(dirname "$file")
  while IFS= read -r target; do
    [ -e "$dir/$target" ] || printf '%s: link to a file that does not exist: %s\n' "$file" "$target" >>"$problems"
  done < <(link_targets "$file")
}

while IFS= read -r file; do
  check_links "$file"
done < <(find README.md labs docs skills -name '*.md' 2>/dev/null | sort)

# ---------------------------------------------------------- the tutor skill --

# The tutor names the lab pages it reads. Each has to exist in both courses.
skill=skills/data-agent-tutor/SKILL.md
if [ -f "$skill" ]; then
  # shellcheck disable=SC2016  # the backticks are Markdown, not a command
  while IFS= read -r page; do
    for course in cloud local; do
      [ -f "labs/$course/$page" ] ||
        printf '%s names %s, but labs/%s/%s does not exist\n' "$skill" "$page" "$course" "$page" >>"$problems"
    done
  done < <(grep -o '`[0-9a-z-]*\.md`' "$skill" | tr -d '`' | sort -u)
fi

if [ -s "$problems" ]; then
  cat "$problems"
  exit 1
fi
