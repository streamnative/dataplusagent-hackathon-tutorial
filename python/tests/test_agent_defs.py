"""agent_params: turn agent/<layer>.json into the arguments for agents.create/update."""

import inspect
import json
import os
import subprocess

import pytest
from orca.resources.agents.agents import Agents

from common import REPO_ROOT, Config, ConfigError, agent_params, load_layer
from policy import effective_policy

MCP_URL = "https://mcp.example.com/mcp/x/o-test/sqlworkspace/ws-1"


def config(**overrides: str) -> Config:
    values = {"ORCA_MODEL": "claude-sonnet-4-6", "SN_MCP_URL": MCP_URL, "RW_MCP_URL": "http://localhost:8080/mcp", **overrides}
    return Config(values=values, participant="jane")


@pytest.mark.parametrize("layer", ["l1-hello", "l3-live-context", "l4-act"])
def test_params_are_accepted_by_the_real_sdk_methods(layer):
    params = agent_params(load_layer(layer), config())

    inspect.signature(Agents.create).bind(None, **params)
    inspect.signature(Agents.update).bind(None, "agent_1", version=1, **params)


def test_the_agent_is_named_after_the_participant():
    assert agent_params(load_layer("l1-hello"), config())["name"] == "hello-agent-jane"


def test_the_model_comes_from_the_config():
    assert agent_params(load_layer("l1-hello"), config(ORCA_MODEL="claude-sonnet-5"))["model"] == "claude-sonnet-5"


def test_l1_explicitly_clears_tools_and_mcp_servers():
    # Updates are partial: an omitted field keeps its old value, so going back to
    # L1 after L3 must send empty lists to detach the MCP server.
    params = agent_params(load_layer("l1-hello"), config())

    assert params["tools"] == []
    assert params["mcp_servers"] == []


def test_the_mcp_server_url_comes_from_the_team_card():
    params = agent_params(load_layer("l3-live-context"), config())

    assert params["mcp_servers"] == [{"name": "streamnative", "type": "url", "url": MCP_URL}]


def test_a_placeholder_without_a_value_is_a_config_error():
    no_url = Config(values={"ORCA_MODEL": "claude-sonnet-4-6"}, participant="jane")

    with pytest.raises(ConfigError, match="SN_MCP_URL"):
        agent_params(load_layer("l3-live-context"), no_url)


def test_different_layers_carry_different_definition_fingerprints():
    fingerprint = lambda layer: agent_params(load_layer(layer), config())["metadata"]["definition_sha"]  # noqa: E731

    assert len({fingerprint("l1-hello"), fingerprint("l3-live-context"), fingerprint("l4-act")}) == 3
    assert fingerprint("l3-live-context") == fingerprint("l3-live-context")


@pytest.mark.parametrize("layer", ["l3-live-context", "l4-act"])
def test_configured_database_scopes_cloud_agent_and_changes_fingerprint(layer):
    params = agent_params(load_layer(layer), config(SN_SQL_DATABASE='catalog-\"rfu'))
    assert params["system"].startswith('Target SQL database: "catalog-\\\"rfu".')
    assert "never fall back to another database" in params["system"]
    assert params["metadata"]["definition_sha"] != agent_params(load_layer(layer), config())["metadata"]["definition_sha"]
    assert params["metadata"]["definition_sha"] != agent_params(load_layer(layer), config(SN_SQL_DATABASE="other"))["metadata"]["definition_sha"]


@pytest.mark.parametrize("layer, stack", [("l1-hello", "cloud"), ("l3-live-context", "local"), ("l4-act", "local")])
def test_database_setting_does_not_change_hello_or_local_agents(layer, stack):
    definition = load_layer(layer, stack)
    assert agent_params(definition, config(TUTORIAL_STACK=stack, SN_SQL_DATABASE="catalog-rfu")) == agent_params(definition, config(TUTORIAL_STACK=stack))


@pytest.mark.parametrize("layer", ["l3-live-context", "l4-act"])
def test_cli_database_definition_matches_python_without_loading_dotenv(layer):
    # Extract only the pure definition builder; never source lib.sh/env.sh or .env.
    source = (REPO_ROOT / "cli/lib.sh").read_text()
    builder = source[source.index("agent_definition() {"):source.index("\n# Same recipe as the other languages")]
    script = """layer_file() { printf '%s/agent/cloud/%s.json' "$REPO" "$1"; }
""" + builder + '\nagent_definition "$LAYER"'
    env = {"PATH": os.environ["PATH"], "REPO": str(REPO_ROOT), "LAYER": layer,
           "HELLO_PARTICIPANT": "jane", "ORCA_MODEL": "claude-sonnet-4-6",
           "SN_MCP_URL": MCP_URL, "SN_SQL_DATABASE": 'catalog-\"rfu'}
    result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, check=True)
    expected = agent_params(load_layer(layer), config(SN_SQL_DATABASE=env["SN_SQL_DATABASE"]))
    expected.pop("metadata")
    assert json.loads(result.stdout) == expected


@pytest.mark.parametrize(
    "layer, tool, expected",
    [
        ("l3-live-context", "sql_workspace_list_databases", "always_allow"),
        ("l3-live-context", "sql_workspace_query", "always_allow"),
        ("l3-live-context", "sql_workspace_describe_table", "disabled"),
        ("l3-live-context", "sql_workspace_insert_rows", "disabled"),
        ("l3-live-context", "sql_workspace_delete_rows", "disabled"),
        ("l3-live-context", "kafka_client_produce", "disabled"),
        ("l4-act", "sql_workspace_query", "always_allow"),
        ("l4-act", "sql_workspace_describe_table", "always_allow"),
        ("l4-act", "sql_workspace_insert_rows", "always_ask"),
        ("l4-act", "sql_workspace_delete_rows", "disabled"),
        ("l4-act", "sql_workspace_create_materialized_view", "disabled"),
        ("l4-act", "kafka_client_produce", "disabled"),
    ],
)
def test_tool_permissions_per_layer(layer, tool, expected):
    params = agent_params(load_layer(layer), config())

    assert effective_policy(params, "streamnative", tool) == expected
