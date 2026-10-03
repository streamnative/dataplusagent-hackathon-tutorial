# shellcheck shell=bash
# Loads your .env for the CLI scripts. Sourced by them, never run directly.
#
#   hello_setup VAR...   read ../.env, check the named variables, point ork at
#                        your Agent Engine, and pick your stack and participant name.
#
# Variables you export in your shell win over .env, as in the Python and
# TypeScript paths.

HELLO_CLI_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HELLO_REPO_ROOT=$(cd "$HELLO_CLI_DIR/.." && pwd)

hello_trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}

# KEY=VALUE lines only: the file is parsed, never executed.
hello_load_dotenv() {
  local file="$HELLO_REPO_ROOT/.env" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line=$(hello_trim "${line%$'\r'}")
    case "$line" in '' | '#'*) continue ;; esac
    line=${line#export }
    case "$line" in *=*) ;; *) continue ;; esac
    key=$(hello_trim "${line%%=*}")
    value=$(hello_trim "${line#*=}")
    case "$key" in '' | [0-9]* | *[!A-Za-z0-9_]*) continue ;; esac
    case "$value" in
      \"*\") value=${value#\"} value=${value%\"} ;;
      \'*\') value=${value#\'} value=${value%\'} ;;
      *) value=$(hello_trim "${value%% #*}") ;;
    esac
    if ! printenv "$key" >/dev/null; then
      export "$key=$value"
    fi
  done <"$file"
}

hello_die() {
  printf '\n%s\n' "$1" >&2
  exit 1
}

# How to get a complete .env, for the stack this one is for.
hello_setup_hint() {
  if [ "$(hello_trim "${TUTORIAL_STACK:-}")" = local ]; then
    printf '%s' "Run local/write-env.sh in the repo root to write .env again (Local course, Lab 0)."
  else
    printf '%s' "Copy .env.cloud.example to .env in the repo root and fill it in from your team card, or run local/write-env.sh for the Local course."
  fi
}

hello_require() {
  local name value missing=""
  for name in "$@"; do
    value=$(hello_trim "$(printenv "$name" || true)")
    if [ -z "$value" ]; then
      missing="${missing:+$missing, }$name"
    else
      export "$name=$value"
    fi
  done
  if [ -n "$missing" ]; then
    hello_die "Missing $missing. $(hello_setup_hint)"
  fi
}

# Lowercase letters, digits, and dashes: safe in every resource name.
hello_slug() {
  local slug
  slug=$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
  slug=$(printf '%s' "$slug" | cut -c1-32 | sed -E 's/-+$//')
  printf '%s' "${slug:-participant}"
}

hello_setup() {
  command -v ork >/dev/null ||
    hello_die "ork (the Orca CLI) is not installed. Every path uses it for the checks, and the CLI path for the lab scripts. See docs/before-you-arrive.md."
  command -v jq >/dev/null ||
    hello_die "jq is not installed. Install it (brew install jq, apt install jq, or winget install jqlang.jq) and try again."

  hello_load_dotenv
  # `cloud`: your team card on StreamNative Cloud. `local`: the stack on your laptop.
  HELLO_STACK=$(hello_trim "${TUTORIAL_STACK:-cloud}")
  case "$HELLO_STACK" in
    cloud | local) ;;
    *) hello_die "TUTORIAL_STACK must be cloud or local." ;;
  esac
  # Registry workspace keys use x-api-key; team-card keys use Bearer.
  # Keep the two CLI credentials mutually exclusive.
  if [ -n "$(hello_trim "${ORCA_API_KEY:-}")" ]; then
    hello_require "$@" ORCA_API_KEY
    unset ORCA_ACCESS_TOKEN
  else
    hello_require "$@" SN_API_KEY
    export ORCA_ACCESS_TOKEN="$SN_API_KEY"
    unset ORCA_API_KEY
  fi
  export ORCA_REGISTRY_URL="$ORCA_BASE_URL"

  local who suffix=""
  who=$(printenv PARTICIPANT || true)
  [ -n "$(hello_trim "$who")" ] || who=${LOGNAME:-${USER:-${LNAME:-${USERNAME:-$(id -un 2>/dev/null || true)}}}}
  HELLO_PARTICIPANT=$(hello_slug "$who")
  # Each stack has its own Agent Engine, so each keeps its ids in its own file.
  [ "$HELLO_STACK" = cloud ] || suffix=.local
  HELLO_STATE_FILE="$HELLO_REPO_ROOT/.orca-state/$HELLO_PARTICIPANT$suffix.json"
  export HELLO_STACK HELLO_PARTICIPANT HELLO_STATE_FILE
}
