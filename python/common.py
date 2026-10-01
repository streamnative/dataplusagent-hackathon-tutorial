"""Shared helpers for the Python path of the tutorial.

The layer scripts (l1_hello.py, l3_live_context.py, l4_act.py) stay short by
leaning on these helpers. Read those first; come here when you want the details.
"""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping

from dotenv import dotenv_values
from orca import APIConnectionError, APIStatusError, ConflictError, NotFoundError, Orca
from orca.types import Agent

REPO_ROOT = Path(__file__).resolve().parent.parent

# ------------------------------------------------------------------ config --


class ConfigError(RuntimeError):
    """The team card (.env) is missing something."""


@dataclass(frozen=True)
class Config:
    values: Mapping[str, str] = field(repr=False)  # holds your API key: never print it
    participant: str

    def __getitem__(self, name: str) -> str:
        return self.values[name]


def load_config(required: list[str], env: Mapping[str, str] | None = None) -> Config:
    """Read the team card: the repo's .env file, overridden by exported variables."""
    if env is None:
        env = {**dotenv_values(REPO_ROOT / ".env"), **os.environ}
    values = {name: value.strip() for name, value in env.items() if value and value.strip()}
    missing = [name for name in required if name not in values]
    if missing:
        raise ConfigError(
            f"Missing {', '.join(missing)}. Copy .env.example to .env in the repo root and fill it in from your team card."
        )
    return Config(values=values, participant=_slug(values.get("PARTICIPANT") or getpass.getuser()))


def _slug(raw: str) -> str:
    """Lowercase letters, digits, and dashes: safe in every resource name."""
    return re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")[:32].strip("-") or "participant"


# ------------------------------------------------------------------- state --


class State:
    """Remembers the ids your scripts created, in .orca-state/<participant>.json."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._data = json.loads(self.path.read_text()) if self.path.exists() else {}

    def get(self, key: str) -> str | None:
        return self._data.get(key)

    def set(self, key: str, value: str) -> None:
        self._data[key] = value
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._data, indent=2) + "\n")


def state_for(config: Config) -> State:
    return State(REPO_ROOT / ".orca-state" / f"{config.participant}.json")


# ------------------------------------------------------- agent definitions --

_PLACEHOLDER = re.compile(r"\$\{([A-Z0-9_]+)\}")


def load_layer(name: str) -> dict[str, Any]:
    """Read agent/<name>.json: the same file the CLI and TypeScript paths use."""
    return json.loads((REPO_ROOT / "agent" / f"{name}.json").read_text())


def agent_params(layer: dict[str, Any], config: Config) -> dict[str, Any]:
    """The arguments for agents.create/update: the layer's JSON plus your name and model."""
    params = {
        "name": f"hello-agent-{config.participant}",
        "model": config["ORCA_MODEL"],
        "system": layer["system"],
        # Always sent, even when empty: updates are partial, and an omitted
        # field would keep the previous layer's value.
        "mcp_servers": _fill(layer["mcp_servers"], config),
        "tools": _fill(layer["tools"], config),
    }
    # Same recipe in every language (and `jq -cS` in the CLI): compact JSON, sorted keys.
    canonical = json.dumps(params, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    fingerprint = hashlib.sha256(canonical.encode()).hexdigest()[:16]
    params["metadata"] = {"tutorial": "dss2026-hello-world", "layer": layer["layer"], "definition_sha": fingerprint}
    return params


def _fill(value: Any, config: Config) -> Any:
    """Replace ${NAME} placeholders with values from the team card."""
    if isinstance(value, str):
        return _PLACEHOLDER.sub(lambda match: _lookup(match.group(1), config), value)
    if isinstance(value, list):
        return [_fill(item, config) for item in value]
    if isinstance(value, dict):
        return {key: _fill(item, config) for key, item in value.items()}
    return value


def _lookup(name: str, config: Config) -> str:
    if name not in config.values:
        raise ConfigError(f"Missing {name}: the agent definition needs it. Add it to .env from your team card.")
    return config.values[name]


# ------------------------------------------------- Agent Engine resources --


def orca_client(config: Config) -> Orca:
    """Use a Registry workspace key locally, or the team card's hosted Bearer key."""
    if key := config.values.get("ORCA_API_KEY"):
        return Orca(base_url=config["ORCA_BASE_URL"], api_key=None, default_headers={"x-api-key": key}, timeout=600)
    if key := config.values.get("SN_API_KEY"):
        return Orca(base_url=config["ORCA_BASE_URL"], api_key=key, timeout=600)
    raise ConfigError("Set ORCA_API_KEY for ork local, or SN_API_KEY from your team card.")


def ensure_environment(client: Any, state: State, name: str) -> str:
    """The sandbox your sessions run in. Created once, then reused."""
    environment = _live(client.environments.retrieve, state.get("environment_id"))
    if environment is None:
        try:
            environment = client.environments.create(name=name)
        except ConflictError:
            # Names stay reserved after an environment is archived: pick a fresh one.
            environment = client.environments.create(name=f"{name}-{secrets.token_hex(2)}")
        state.set("environment_id", environment.id)
    return environment.id


def ensure_agent(client: Any, state: State, params: dict[str, Any]) -> Agent:
    """Create your agent, or update it when the layer's definition changed."""
    agent = _live(client.agents.retrieve, state.get("agent_id"))
    if agent is None:
        agent = client.agents.create(**params)
        state.set("agent_id", agent.id)
    elif agent.metadata.get("definition_sha") != params["metadata"]["definition_sha"]:
        # Every update is a new version. `version` guards against a concurrent edit.
        agent = client.agents.update(agent.id, version=agent.version, **params)
    return agent


def mcp_auth_type(config: Config) -> str:
    mode = config.values.get("SN_MCP_AUTH", "oauth")
    if mode not in ("oauth", "static_bearer"):
        raise ConfigError("SN_MCP_AUTH must be oauth or static_bearer.")
    return "mcp_oauth" if mode == "oauth" else "static_bearer"


def authorize_mcp(vault_id: str, config: Config) -> None:
    """Let ork handle discovery, browser login, PKCE and server-side token storage."""
    args = ["ork", "agent", "vaults", "credentials", "create", "--vault", vault_id,
            "--display-name", "streamnative-mcp", "--mcp-server-url", config["SN_MCP_URL"], "-o", "json"]
    for name, flag in (("SN_MCP_OAUTH_ISSUER", "--oauth-issuer"), ("SN_MCP_OAUTH_SCOPE", "--oauth-scope")):
        if value := config.values.get(name):
            args += [flag, value]
    env = dict(os.environ)
    env["ORCA_REGISTRY_URL"] = config["ORCA_BASE_URL"]
    # Export only the chosen Registry credential, never pass it in argv.
    env.pop("ORCA_API_KEY", None)
    env.pop("ORCA_ACCESS_TOKEN", None)
    if config.values.get("ORCA_API_KEY"):
        env["ORCA_API_KEY"] = config["ORCA_API_KEY"]
    else:
        env["ORCA_ACCESS_TOKEN"] = config["SN_API_KEY"]
    try:
        result = subprocess.run(args, env=env, check=False)
    except OSError:
        raise ConfigError("Install ork with MCP OAuth proxy support and put it on PATH (see docs/before-you-arrive.md).") from None
    if result.returncode:
        raise ConfigError("MCP OAuth authorization failed. Check the ork error above; normally leave SN_MCP_OAUTH_ISSUER empty for discovery, then rerun L3/L4.")


def ensure_vault(client: Any, state: State, name: str, config: Config) -> str:
    """A vault holding the credential the agent uses to call the MCP server.

    The token lives in the vault on the server side; it never enters a prompt.
    """
    auth_type = mcp_auth_type(config)
    mcp_url = config["SN_MCP_URL"]
    if auth_type == "static_bearer" and not config.values.get("SN_API_KEY"):
        raise ConfigError("SN_MCP_AUTH=static_bearer requires SN_API_KEY.")
    vault = _live(client.vaults.retrieve, state.get("vault_id"))
    if vault is None:
        vault = client.vaults.create(display_name=name)
        state.set("vault_id", vault.id)
    credentials = client.vaults.credentials.list(vault.id).data
    if not any(getattr(c.auth, "mcp_server_url", None) == mcp_url
               and c.auth.type == auth_type and not c.archived_at for c in credentials):
        # Registry permits only one active credential per MCP URL in a vault.
        # Retire the old auth mode before creating its replacement.
        for credential in credentials:
            if getattr(credential.auth, "mcp_server_url", None) == mcp_url and not credential.archived_at:
                client.vaults.credentials.archive(vault.id, credential.id)
        if auth_type == "mcp_oauth":
            authorize_mcp(vault.id, config)
        else:
            client.vaults.credentials.create(
                vault.id,
                display_name="streamnative-mcp",
                auth={"type": "static_bearer", "mcp_server_url": mcp_url, "token": config["SN_API_KEY"]},
            )
    return vault.id


def _live(retrieve: Callable[[str], Any], resource_id: str | None) -> Any:
    """The remembered resource, or None if it was never created, deleted, or archived."""
    if not resource_id:
        return None
    try:
        resource = retrieve(resource_id)
    except NotFoundError:
        return None
    return None if resource.archived_at else resource

# ------------------------------------------------------------- the scripts --


def chat(
    client: Any,
    session_id: str,
    first: str,
    *,
    confirm: Callable[[dict[str, Any]], bool] | None = None,
    ask: Callable[[str], str] = input,
    out: Callable[[str], None] = print,
) -> None:
    """Ask `first`, then whatever the participant types next, until they type nothing."""
    question = first
    while question:
        out(f"[you]    {question}")
        run_turn(client, session_id, question, confirm=confirm, out=out)
        question = ask("\nAsk again (Enter to quit): ").strip()


def ask_human(tool_use: dict[str, Any], *, ask: Callable[[str], str] = input, out: Callable[[str], None] = print) -> bool:
    """Show the tool call the agent wants to make, and let the human decide."""
    out(f"\n[approve?] The agent wants to run {tool_use.get('name')} with:")
    out(json.dumps(tool_use.get("input", {}), indent=2))
    return ask("Allow it? [y/N] ").strip().lower() in ("y", "yes")


def cleanup(client: Any, state: State, *, out: Callable[[str], None] = print) -> None:
    """Archive the agent and environment, and delete the vault. Sessions reserve the environment."""
    steps = [
        ("agent", "agent_id", client.agents.archive),
        ("vault", "vault_id", client.vaults.delete),
        ("environment", "environment_id", client.environments.archive),
    ]
    for label, key, remove in steps:
        resource_id = state.get(key)
        if not resource_id:
            continue
        try:
            remove(resource_id)
            out(f"removed {label} {resource_id}")
        except NotFoundError:
            out(f"{label} {resource_id} was already gone")
    state.path.unlink(missing_ok=True)


def run_main(main: Callable[[], None]) -> None:
    """Run a script, turning known failures into a short explanation."""
    try:
        main()
    except (ConfigError, TurnError) as err:
        sys.exit(f"\n{err}")
    except APIStatusError as err:
        sys.exit(f"\nAgent Engine returned HTTP {err.status_code}: {err.message}\nRun `python doctor.py` to check your setup.")
    except APIConnectionError:
        sys.exit("\nCannot reach the Agent Engine. Check ORCA_BASE_URL in .env, then run `python doctor.py`.")
    except KeyboardInterrupt:
        sys.exit(130)


# ---------------------------------------------------------------- one turn --


class TurnError(RuntimeError):
    """The agent's turn could not complete."""


@dataclass
class TurnResult:
    text: str


DENY_MESSAGE = "The human reviewer denied this action."
PREVIEW_CHARS = 160


def run_turn(
    client: Any,
    session_id: str,
    text: str,
    *,
    confirm: Callable[[dict[str, Any]], bool] | None = None,
    out: Callable[[str], None] = print,
) -> TurnResult:
    """Send one user message and follow the session until the agent's turn ends.

    `confirm(tool_use)` is asked whenever a tool with an `always_ask` policy wants
    to run; return True to allow it, False to deny it.
    """
    events = client.sessions.events
    # Listen first, then speak: an event emitted between the two would be lost.
    with events.stream(session_id) as stream:
        sent = events.send(session_id, events=[{"type": "user.message", "content": [{"type": "text", "text": text}]}])
        # Some servers replay the whole transcript on connect. Everything
        # processed before our message belongs to an earlier turn.
        since = sent.data[0].processed_at if sent.data else None
        seen: set[str] = set()
        tool_uses: dict[str, dict[str, Any]] = {}
        replies: list[str] = []
        last_error = ""

        for raw in stream:
            event = raw.to_dict()
            if event["id"] in seen or _before(event.get("processed_at"), since):
                continue
            seen.add(event["id"])
            kind = event["type"]

            if kind == "agent.message":
                reply = "".join(b.get("text", "") for b in event.get("content", []) if b.get("type") == "text")
                replies.append(reply)
                out(f"[agent]  {reply}")
            elif kind == "agent.mcp_tool_use":
                tool_uses[event["id"]] = event
                out(_shorten(f"[tool]   {event.get('name')} {json.dumps(event.get('input', {}))}"))
            elif kind == "agent.mcp_tool_result":
                label = "error" if event.get("is_error") else "result"
                out(_shorten(f"[{label}] {_content_text(event.get('content'))}"))
            elif kind == "session.error":
                error = event.get("error") or {}
                last_error = error.get("message") or error.get("type") or "unknown error"
                retrying = (event.get("retry_status") or {}).get("will_retry")
                out(f"[error]  {last_error}" + (" (retrying)" if retrying else ""))
            elif kind == "session.status_idle":
                stop = event.get("stop_reason") or {}
                if stop.get("type") == "requires_action":
                    _answer_approvals(events, session_id, stop.get("event_ids", []), tool_uses, confirm)
                    continue
                if stop.get("type") == "end_turn":
                    return TurnResult(text="\n".join(replies))
                raise TurnError(f"The agent stopped ({stop.get('type')}): {last_error or 'no details'}")

    raise TurnError("The event stream ended before the agent finished its turn.")


def _answer_approvals(events: Any, session_id: str, event_ids: list[str], tool_uses: dict, confirm) -> None:
    if confirm is None:
        raise TurnError("The agent is waiting for human approval, but this script has no approver.")
    decisions = []
    for tool_use_id in event_ids:
        allowed = confirm(tool_uses.get(tool_use_id, {"id": tool_use_id}))
        decision = {"type": "user.tool_confirmation", "tool_use_id": tool_use_id, "result": "allow" if allowed else "deny"}
        if not allowed:
            decision["deny_message"] = DENY_MESSAGE
        decisions.append(decision)
    events.send(session_id, events=decisions)


def _before(processed_at: str | None, since: str | None) -> bool:
    if not processed_at or not since:
        return False
    return _timestamp(processed_at) < _timestamp(since)


def _timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _content_text(content: Any) -> str:
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    return ""


def _shorten(line: str) -> str:
    return line if len(line) <= PREVIEW_CHARS else line[: PREVIEW_CHARS - 1] + "…"


