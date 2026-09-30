"""In-memory stand-ins for the parts of the Orca API the tutorial touches.

The fakes mirror the real SDK surface (method names, keyword arguments, return
shapes) and hand back real `orca.types` models, so the code under test runs the
same way it does against a live Agent Engine.
"""

from __future__ import annotations

import itertools
from types import SimpleNamespace
from typing import Any

from orca import ConflictError, NotFoundError
from orca.types import Environment, SessionEvent, Vault, VaultCredential

NOW = "2026-10-07T10:00:00Z"
CLOUD_CONFIG = {
    "type": "cloud",
    "packages": {"type": "packages", "apt": [], "cargo": [], "gem": [], "go": [], "npm": [], "pip": []},
    "networking": {"type": "unrestricted"},
}


def event(**fields: Any) -> SessionEvent:
    return SessionEvent(**fields)


class FakeStream:
    """A server-sent-event stream: yields whatever the session has queued."""

    def __init__(self, queue: list[SessionEvent]) -> None:
        self._queue = queue

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def __iter__(self):
        while self._queue:
            yield self._queue.pop(0)


class FakeSessionEvents:
    """A scripted session.

    `reactions[i]` are the events the agent emits after the i-th `send()` call.
    `history` models a server whose stream replays the whole transcript on
    connect. `echo_user_events` controls whether sent events reappear on the
    stream (servers differ).
    """

    def __init__(
        self,
        reactions: list[list[dict[str, Any]]],
        history: list[dict[str, Any]] = (),
        echo_user_events: bool = True,
    ) -> None:
        self.calls: list[tuple] = []
        self._reactions = list(reactions)
        self._history = [event(**h) for h in history]
        self._queue: list[SessionEvent] = []
        self._echo = echo_user_events
        self._ticks = itertools.count(1)
        self._ids = itertools.count(1)

    def _now(self) -> str:
        return f"2026-10-07T10:00:{next(self._ticks):02d}.000Z"

    def stream(self, session_id: str, **_: Any) -> FakeStream:
        self.calls.append(("stream", session_id))
        self._queue.extend(self._history)
        return FakeStream(self._queue)

    def send(self, session_id: str, *, events: list[dict[str, Any]]) -> SimpleNamespace:
        self.calls.append(("send", session_id, events))
        persisted = [
            event(id=f"evt_user_{next(self._ids)}", processed_at=self._now(), **e) for e in events
        ]
        if self._echo:
            self._queue.extend(persisted)
        for reaction in self._reactions.pop(0) if self._reactions else []:
            self._queue.append(event(**{"processed_at": self._now(), **reaction}))
        return SimpleNamespace(data=persisted)


def client_with_events(events: FakeSessionEvents) -> SimpleNamespace:
    return SimpleNamespace(sessions=SimpleNamespace(events=events))


# -- agents / environments / vaults ------------------------------------------


def _agent(id: str, version: int, name: str, params: dict[str, Any], archived: bool = False):
    from orca.types import Agent

    return Agent(
        id=id,
        type="agent",
        name=name,
        description=None,
        model={"id": params["model"]},
        system=params.get("system"),
        mcp_servers=params.get("mcp_servers", []),
        tools=params.get("tools", []),
        skills=[],
        metadata=params.get("metadata", {}),
        version=version,
        created_at="2026-10-07T10:00:00Z",
        updated_at="2026-10-07T10:00:00Z",
        archived_at="2026-10-07T11:00:00Z" if archived else None,
    )


def _not_found() -> NotFoundError:
    import httpx2

    request = httpx2.Request("GET", "https://ws.example.com/v1/x")
    return NotFoundError("not found", response=httpx2.Response(404, request=request), body=None)


def _conflict() -> ConflictError:
    import httpx2

    request = httpx2.Request("POST", "https://ws.example.com/v1/x")
    return ConflictError("name taken", response=httpx2.Response(409, request=request), body=None)


class FakeAgents:
    def __init__(self) -> None:
        self.store: dict[str, Any] = {}
        self.calls: list[tuple] = []

    def create(self, **params: Any):
        self.calls.append(("create", params))
        agent = _agent(f"agent_{len(self.store) + 1}", 1, params["name"], params)
        self.store[agent.id] = agent
        return agent

    def retrieve(self, agent_id: str):
        self.calls.append(("retrieve", agent_id))
        if agent_id not in self.store:
            raise _not_found()
        return self.store[agent_id]

    def archive(self, agent_id: str):
        self.calls.append(("archive", agent_id))
        if agent_id not in self.store:
            raise _not_found()
        self.store[agent_id] = _archived(self.store[agent_id])
        return self.store[agent_id]

    def update(self, agent_id: str, **params: Any):
        self.calls.append(("update", agent_id, params))
        current = self.store[agent_id]
        if params.get("version") != current.version:
            raise _conflict()
        merged = {**current.to_dict(), **{k: v for k, v in params.items() if k != "version"}}
        merged["model"] = params.get("model", current.model.id)
        agent = _agent(agent_id, current.version + 1, merged["name"], merged)
        self.store[agent_id] = agent
        return agent


def _archived(resource):
    return resource.model_copy(update={"archived_at": NOW})


class FakeEnvironments:
    def __init__(self, taken_names: set[str] = frozenset()) -> None:
        self.store: dict[str, Any] = {}
        self.taken = set(taken_names)
        self.calls: list[tuple] = []

    def create(self, *, name: str, **_: Any):
        self.calls.append(("create", name))
        if name in self.taken:
            raise _conflict()
        self.taken.add(name)
        env = Environment(
            id=f"env_{len(self.store) + 1}",
            type="environment",
            name=name,
            description="",
            config=CLOUD_CONFIG,
            metadata={},
            created_at=NOW,
            updated_at=NOW,
        )
        self.store[env.id] = env
        return env

    def retrieve(self, environment_id: str):
        self.calls.append(("retrieve", environment_id))
        if environment_id not in self.store:
            raise _not_found()
        return self.store[environment_id]

    def archive(self, environment_id: str):
        self.calls.append(("archive", environment_id))
        if environment_id not in self.store:
            raise _not_found()
        self.store[environment_id] = _archived(self.store[environment_id])
        return self.store[environment_id]

    def delete(self, environment_id: str):
        self.calls.append(("delete", environment_id))
        if self.store.pop(environment_id, None) is None:
            raise _not_found()


class FakeCredentials:
    def __init__(self) -> None:
        self.store: dict[str, list[Any]] = {}
        self.calls: list[tuple] = []

    def create(self, vault_id: str, *, auth: dict[str, Any], display_name: str | None = None):
        self.calls.append(("create", vault_id, auth, display_name))
        cred = VaultCredential(
            id=f"cred_{sum(len(v) for v in self.store.values()) + 1}",
            type="vault_credential",
            vault_id=vault_id,
            display_name=display_name,
            auth={"type": auth["type"], "mcp_server_url": auth["mcp_server_url"]},  # the token is never returned
            metadata={},
            created_at=NOW,
            updated_at=NOW,
        )
        self.store.setdefault(vault_id, []).append(cred)
        return cred

    def list(self, vault_id: str, **_: Any):
        self.calls.append(("list", vault_id))
        return SimpleNamespace(data=list(self.store.get(vault_id, [])))


class FakeVaults:
    def __init__(self) -> None:
        self.store: dict[str, Any] = {}
        self.calls: list[tuple] = []
        self.credentials = FakeCredentials()

    def create(self, *, display_name: str, **_: Any):
        self.calls.append(("create", display_name))
        vault = Vault(
            id=f"vlt_{len(self.store) + 1}", type="vault", display_name=display_name, metadata={}, created_at=NOW, updated_at=NOW
        )
        self.store[vault.id] = vault
        return vault

    def retrieve(self, vault_id: str):
        self.calls.append(("retrieve", vault_id))
        if vault_id not in self.store:
            raise _not_found()
        return self.store[vault_id]

    def delete(self, vault_id: str):
        self.calls.append(("delete", vault_id))
        if self.store.pop(vault_id, None) is None:
            raise _not_found()


def fake_client(taken_env_names: set[str] = frozenset()) -> SimpleNamespace:
    return SimpleNamespace(
        agents=FakeAgents(),
        environments=FakeEnvironments(taken_env_names),
        vaults=FakeVaults(),
    )
