"""TUTORIAL_STACK: a team card on StreamNative Cloud, or the whole stack on your laptop."""

import inspect
from unittest.mock import Mock

import pytest
from orca.resources.agents.agents import Agents

from common import (
    Config,
    ConfigError,
    State,
    agent_params,
    ensure_agent,
    kafka_client_config,
    load_config,
    load_layer,
    mcp_vault_ids,
    open_session,
    schema_registry_config,
    state_for,
)
from fakes import fake_client
from policy import effective_policy

CLOUD = {
    "SN_API_KEY": "the-api-key",
    "SN_SERVICE_ACCOUNT": "team-07@o-test.auth.streamnative.cloud",
    "KAFKA_BOOTSTRAP_SERVERS": "kafka.example.com:9093",
    "SCHEMA_REGISTRY_URL": "https://sr.example.com",
    "SN_MCP_URL": "https://mcp.example.com/mcp",
    "SN_MCP_AUTH": "static_bearer",
    "ORCA_MODEL": "claude-sonnet-4-6",
}
LOCAL = {
    "TUTORIAL_STACK": "local",
    "KAFKA_BOOTSTRAP_SERVERS": "127.0.0.1:29092",
    "SCHEMA_REGISTRY_URL": "http://127.0.0.1:18081",
    "RW_MCP_URL": "http://risingwave-mcp:8000/mcp",
    "ORCA_MODEL": "claude-sonnet-4-6",
}


def config(values: dict[str, str]) -> Config:
    return Config(values=values, participant="jane")


# ------------------------------------------------------------- the switch --


def test_a_team_card_without_the_switch_is_the_cloud_stack():
    assert config(CLOUD).stack == "cloud"


def test_the_local_stack_is_chosen_in_the_env():
    assert config(LOCAL).stack == "local"


def test_an_unknown_stack_is_a_config_error():
    with pytest.raises(ConfigError, match="TUTORIAL_STACK"):
        config({"TUTORIAL_STACK": "laptop"}).stack


def test_each_stack_remembers_its_ids_in_its_own_file():
    assert state_for(config(CLOUD)).path.name == "jane.json"
    assert state_for(config(LOCAL)).path.name == "jane.local.json"


# ----------------------------------------------- Kafka and Schema Registry --


def test_the_cloud_stack_reaches_kafka_with_sasl_over_tls():
    assert kafka_client_config(config(CLOUD)) == {
        "bootstrap.servers": "kafka.example.com:9093",
        "security.protocol": "SASL_SSL",
        "sasl.mechanisms": "PLAIN",
        "sasl.username": "team-07@o-test.auth.streamnative.cloud",
        "sasl.password": "the-api-key",
    }


def test_the_local_stack_reaches_kafka_in_plaintext_without_credentials():
    assert kafka_client_config(config(LOCAL)) == {"bootstrap.servers": "127.0.0.1:29092", "security.protocol": "PLAINTEXT"}


def test_the_cloud_schema_registry_uses_the_service_account():
    assert schema_registry_config(config(CLOUD)) == {
        "url": "https://sr.example.com",
        "basic.auth.user.info": "team-07@o-test.auth.streamnative.cloud:the-api-key",
    }


def test_the_local_schema_registry_needs_no_credentials():
    assert schema_registry_config(config(LOCAL)) == {"url": "http://127.0.0.1:18081"}


def test_a_cloud_card_without_the_service_account_names_what_is_missing():
    card = {name: value for name, value in CLOUD.items() if name != "SN_SERVICE_ACCOUNT"}

    with pytest.raises(ConfigError, match="SN_SERVICE_ACCOUNT"):
        kafka_client_config(config(card))


# ------------------------------------------------------------------ hints --


def test_without_a_stack_the_hint_names_both_ways_to_get_an_env_file():
    with pytest.raises(ConfigError) as err:
        load_config(["ORCA_BASE_URL"], env={})

    assert ".env.cloud.example" in str(err.value)
    assert "local/write-env.sh" in str(err.value)


def test_on_the_local_stack_the_hint_is_to_write_the_env_file_again():
    with pytest.raises(ConfigError) as err:
        load_config(["ORCA_BASE_URL"], env={"TUTORIAL_STACK": "local"})

    assert "local/write-env.sh" in str(err.value)
    assert "team card" not in str(err.value)


def test_a_missing_placeholder_on_the_local_stack_points_at_write_env():
    no_url = {name: value for name, value in LOCAL.items() if name != "RW_MCP_URL"}

    with pytest.raises(ConfigError, match="RW_MCP_URL.*local/write-env.sh"):
        agent_params(load_layer("l3-live-context", "local"), config(no_url))


# ------------------------------------------------- local agent definitions --


@pytest.mark.parametrize("layer", ["l1-hello", "l3-live-context", "l4-act"])
def test_local_params_are_accepted_by_the_real_sdk_methods(layer):
    params = agent_params(load_layer(layer, "local"), config(LOCAL))

    inspect.signature(Agents.create).bind(None, **params)
    inspect.signature(Agents.update).bind(None, "agent_1", version=1, **params)


def test_the_local_agent_talks_to_the_risingwave_mcp_server():
    params = agent_params(load_layer("l3-live-context", "local"), config(LOCAL))

    assert params["mcp_servers"] == [{"name": "risingwave", "type": "url", "url": "http://risingwave-mcp:8000/mcp"}]


@pytest.mark.parametrize(
    "layer, tool, expected",
    [
        ("l3-live-context", "run_select_query", "always_allow"),
        ("l3-live-context", "describe_table", "disabled"),
        ("l3-live-context", "insert_multiple_rows", "disabled"),
        ("l3-live-context", "drop_table", "disabled"),
        ("l3-live-context", "execute_ddl_statement", "disabled"),
        ("l4-act", "run_select_query", "always_allow"),
        ("l4-act", "describe_table", "always_allow"),
        ("l4-act", "insert_multiple_rows", "always_ask"),
        ("l4-act", "insert_single_row", "disabled"),
        ("l4-act", "delete_rows", "disabled"),
        ("l4-act", "drop_table", "disabled"),
        ("l4-act", "execute_ddl_statement", "disabled"),
    ],
)
def test_local_tool_permissions_per_layer(layer, tool, expected):
    params = agent_params(load_layer(layer, "local"), config(LOCAL))

    assert effective_policy(params, "risingwave", tool) == expected


def test_the_two_stacks_do_not_share_a_definition_fingerprint():
    cloud = agent_params(load_layer("l3-live-context", "cloud"), config(CLOUD))
    local = agent_params(load_layer("l3-live-context", "local"), config(LOCAL))

    assert cloud["metadata"]["definition_sha"] != local["metadata"]["definition_sha"]


# ----------------------------------------------------- vaults and sessions --


@pytest.fixture
def state(tmp_path):
    return State(tmp_path / "jane.json")


def test_on_the_cloud_stack_the_mcp_credential_goes_in_a_vault(state):
    client = fake_client()

    vault_ids = mcp_vault_ids(client, state, config(CLOUD))

    assert vault_ids == [state.get("vault_id")]
    assert [c[0] for c in client.vaults.credentials.calls if c[0] == "create"] == ["create"]


def test_the_local_mcp_server_takes_no_credential_so_there_is_no_vault(state):
    client = fake_client()

    assert mcp_vault_ids(client, state, config(LOCAL)) == []
    assert client.vaults.calls == []
    assert state.get("vault_id") is None


def test_a_session_is_pinned_to_the_agent_version_and_remembered(state):
    client = fake_client()
    agent = ensure_agent(client, state, agent_params(load_layer("l1-hello"), config(CLOUD)))

    session = open_session(client, state, "env_1", agent, "L1: hello")

    assert client.sessions.calls == [
        ("create", {"environment_id": "env_1", "agent": {"type": "agent", "id": agent.id, "version": 1}, "title": "L1: hello"})
    ]
    assert state.get("session_id") == session.id


def test_a_session_gets_vault_ids_only_when_there_is_a_vault(state):
    client = fake_client()
    agent = ensure_agent(client, state, agent_params(load_layer("l1-hello"), config(CLOUD)))

    open_session(client, state, "env_1", agent, "L3: live context", vault_ids=["vlt_1"])
    open_session(client, state, "env_1", agent, "L3: live context", vault_ids=[])

    assert client.sessions.calls[0][1]["vault_ids"] == ["vlt_1"]
    assert "vault_ids" not in client.sessions.calls[1][1]


def test_the_newest_session_replaces_the_remembered_one(state):
    client = fake_client()
    agent = ensure_agent(client, state, agent_params(load_layer("l1-hello"), config(CLOUD)))
    first = open_session(client, state, "env_1", agent, "L1: hello")

    second = open_session(client, state, "env_1", agent, "L1: hello")

    assert first.id != second.id
    assert state.get("session_id") == second.id


def test_cloud_oauth_still_delegates_to_ork(monkeypatch, state):
    authorize = Mock()
    monkeypatch.setattr("common.authorize_mcp", authorize)
    oauth = {name: value for name, value in CLOUD.items() if name != "SN_MCP_AUTH"}

    vault_ids = mcp_vault_ids(fake_client(), state, config(oauth))

    authorize.assert_called_once()
    assert vault_ids == [state.get("vault_id")]
