"""ensure_*: create Agent Engine resources once, then reuse or update them."""

import pytest

from common import Config, State, agent_params, ensure_agent, ensure_environment, ensure_vault, load_layer
from fakes import _agent, fake_client

MCP_URL = "https://mcp.example.com/mcp/x/o-test/sqlworkspace/ws-1"


def params(layer: str) -> dict:
    return agent_params(load_layer(layer), Config(values={"ORCA_MODEL": "claude-sonnet-4-6", "SN_MCP_URL": MCP_URL}, participant="jane"))


@pytest.fixture
def state(tmp_path):
    return State(tmp_path / "jane.json")


def test_first_run_creates_the_agent_and_remembers_it(tmp_path, state):
    client = fake_client()

    agent = ensure_agent(client, state, params("l1-hello"))

    assert agent.version == 1
    assert [c[0] for c in client.agents.calls] == ["create"]
    assert State(tmp_path / "jane.json").get("agent_id") == agent.id


def test_rerunning_a_layer_does_not_create_a_new_version(state):
    client = fake_client()
    ensure_agent(client, state, params("l1-hello"))

    agent = ensure_agent(client, state, params("l1-hello"))

    assert agent.version == 1
    assert "update" not in [c[0] for c in client.agents.calls]


def test_the_next_layer_updates_the_same_agent_to_a_new_version(state):
    client = fake_client()
    first = ensure_agent(client, state, params("l1-hello"))

    upgraded = ensure_agent(client, state, params("l3-live-context"))

    assert upgraded.id == first.id
    assert upgraded.version == 2
    update = next(c for c in client.agents.calls if c[0] == "update")
    assert update[2]["version"] == 1
    assert upgraded.mcp_servers[0].url == MCP_URL


def test_a_remembered_agent_that_no_longer_exists_is_recreated(state):
    client = fake_client()
    state.set("agent_id", "agent_gone")

    agent = ensure_agent(client, state, params("l1-hello"))

    assert agent.id != "agent_gone"
    assert state.get("agent_id") == agent.id


def test_an_archived_agent_is_not_reused(state):
    client = fake_client()
    client.agents.store["agent_old"] = _agent("agent_old", 3, "hello-agent-jane", params("l1-hello"), archived=True)
    state.set("agent_id", "agent_old")

    agent = ensure_agent(client, state, params("l1-hello"))

    assert agent.id != "agent_old"


def test_the_environment_is_created_once_and_reused(state):
    client = fake_client()

    first = ensure_environment(client, state, "hello-env-jane")
    second = ensure_environment(client, state, "hello-env-jane")

    assert first == second
    assert [c[0] for c in client.environments.calls].count("create") == 1


def test_a_reserved_environment_name_gets_a_fresh_suffix(state):
    client = fake_client(taken_env_names={"hello-env-jane"})

    env_id = ensure_environment(client, state, "hello-env-jane")

    name = client.environments.store[env_id].name
    assert name.startswith("hello-env-jane-")


def test_the_vault_gets_one_bearer_credential_for_the_mcp_server(state):
    client = fake_client()

    vault_id = ensure_vault(client, state, "hello-vault-jane", Config(values={"SN_MCP_AUTH": "static_bearer", "SN_MCP_URL": MCP_URL, "SN_API_KEY": "the-api-key"}, participant="jane"))

    creates = client.vaults.credentials.calls
    assert [c for c in creates if c[0] == "create"] == [
        ("create", vault_id, {"type": "static_bearer", "mcp_server_url": MCP_URL, "token": "the-api-key"}, "streamnative-mcp")
    ]


def test_an_existing_credential_for_the_same_server_is_reused(state):
    client = fake_client()
    first = ensure_vault(client, state, "hello-vault-jane", Config(values={"SN_MCP_AUTH": "static_bearer", "SN_MCP_URL": MCP_URL, "SN_API_KEY": "the-api-key"}, participant="jane"))

    second = ensure_vault(client, state, "hello-vault-jane", Config(values={"SN_MCP_AUTH": "static_bearer", "SN_MCP_URL": MCP_URL, "SN_API_KEY": "the-api-key"}, participant="jane"))

    assert first == second
    assert len([c for c in client.vaults.credentials.calls if c[0] == "create"]) == 1


def test_a_new_mcp_url_gets_its_own_credential(state):
    client = fake_client()
    ensure_vault(client, state, "hello-vault-jane", Config(values={"SN_MCP_AUTH": "static_bearer", "SN_MCP_URL": MCP_URL, "SN_API_KEY": "the-api-key"}, participant="jane"))

    ensure_vault(client, state, "hello-vault-jane", Config(values={"SN_MCP_AUTH": "static_bearer", "SN_MCP_URL": MCP_URL + "-v2", "SN_API_KEY": "the-api-key"}, participant="jane"))

    urls = [c[2]["mcp_server_url"] for c in client.vaults.credentials.calls if c[0] == "create"]
    assert urls == [MCP_URL, MCP_URL + "-v2"]
