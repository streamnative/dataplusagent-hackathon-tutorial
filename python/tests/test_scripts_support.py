"""The small helpers the layer scripts share: chat loop, approval prompt, cleanup, errors."""

import httpx2
import pytest
from orca import AuthenticationError

from common import Config, ConfigError, State, TurnError, ask_human, chat, cleanup, ensure_agent, ensure_environment, ensure_vault, run_main
from fakes import FakeSessionEvents, client_with_events, fake_client
from test_ensure import MCP_URL, params


def reply(t):
    return [{"id": f"evt_{t}", "type": "agent.message", "content": [{"type": "text", "text": t}]},
            {"id": f"evt_idle_{t}", "type": "session.status_idle", "stop_reason": {"type": "end_turn"}}]


def test_chat_keeps_asking_until_the_participant_enters_nothing():
    events = FakeSessionEvents([reply("first"), reply("second")])
    answers = iter(["and now?", ""])

    chat(client_with_events(events), "sess_1", "who is under attack?", ask=lambda _prompt: next(answers), out=lambda _l: None)

    sent = [c[2][0]["content"][0]["text"] for c in events.calls if c[0] == "send"]
    assert sent == ["who is under attack?", "and now?"]


@pytest.mark.parametrize("typed, allowed", [("y", True), ("YES", True), (" yes ", True), ("", False), ("n", False), ("nope", False)])
def test_the_human_must_type_yes_to_approve(typed, allowed):
    tool_use = {"id": "evt_t", "name": "sql_workspace_insert_rows", "input": {"rows": [{"account_id": "acct_9123"}]}}
    shown: list[str] = []

    assert ask_human(tool_use, ask=lambda _prompt: typed, out=shown.append) is allowed
    assert any("sql_workspace_insert_rows" in line for line in shown)
    assert any("acct_9123" in line for line in shown)


def test_cleanup_archives_the_agent_and_environment_deletes_the_vault_and_forgets_the_ids(tmp_path):
    client = fake_client()
    state = State(tmp_path / "jane.json")
    agent = ensure_agent(client, state, params("l1-hello"))
    env_id = ensure_environment(client, state, "hello-env-jane")
    vault_id = ensure_vault(client, state, "hello-vault-jane", Config(values={"SN_MCP_AUTH": "static_bearer", "SN_MCP_URL": MCP_URL, "SN_API_KEY": "key"}, participant="jane"))

    cleanup(client, state, out=lambda _l: None)

    assert client.agents.store[agent.id].archived_at is not None
    assert client.environments.store[env_id].archived_at is not None
    assert ("delete", env_id) not in client.environments.calls
    assert vault_id not in client.vaults.store
    assert not (tmp_path / "jane.json").exists()


def test_cleanup_tolerates_resources_that_are_already_gone(tmp_path):
    client = fake_client()
    state = State(tmp_path / "jane.json")
    state.set("agent_id", "agent_gone")
    state.set("environment_id", "env_gone")
    state.set("vault_id", "vlt_gone")

    cleanup(client, state, out=lambda _l: None)

    assert not (tmp_path / "jane.json").exists()


def _auth_error():
    request = httpx2.Request("GET", "https://ws.example.com/v1/agents")
    return AuthenticationError("invalid token", response=httpx2.Response(401, request=request), body=None)


@pytest.mark.parametrize(
    "failure, expected",
    [
        (ConfigError("Missing SN_API_KEY."), "Missing SN_API_KEY."),
        (TurnError("The agent stopped (retries_exhausted): model not found"), "model not found"),
        (_auth_error(), "doctor"),
    ],
)
def test_known_failures_exit_with_a_readable_message(failure, expected):
    def main():
        raise failure

    with pytest.raises(SystemExit) as exit_:
        run_main(main)

    assert expected in str(exit_.value.code)


def test_an_unreachable_agent_engine_exits_with_a_readable_message():
    from orca import APIConnectionError

    def main():
        raise APIConnectionError(request=httpx2.Request("GET", "https://typo.example.com/v1/agents"))

    with pytest.raises(SystemExit) as exit_:
        run_main(main)

    assert "ORCA_BASE_URL" in str(exit_.value.code)
