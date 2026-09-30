"""load_config: read the team card (.env) and fail with every problem at once."""

import pytest

from common import ConfigError, load_config, orca_client

CARD = {
    "ORCA_BASE_URL": "https://ws.example.com",
    "SN_API_KEY": "key",
    "ORCA_MODEL": "claude-sonnet-4-6",
}


def test_every_missing_variable_is_named_in_one_error():
    with pytest.raises(ConfigError) as err:
        load_config(["ORCA_BASE_URL", "SN_API_KEY", "ORCA_MODEL"], env={"ORCA_MODEL": "m"})

    message = str(err.value)
    assert "ORCA_BASE_URL" in message
    assert "SN_API_KEY" in message
    assert "ORCA_MODEL" not in message


def test_a_blank_value_counts_as_missing():
    with pytest.raises(ConfigError, match="SN_API_KEY"):
        load_config(["SN_API_KEY"], env={"SN_API_KEY": "   "})


def test_values_are_available_by_name():
    config = load_config(["ORCA_BASE_URL"], env=CARD)

    assert config["ORCA_BASE_URL"] == "https://ws.example.com"


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Jane.Doe_42", "jane-doe-42"),
        ("  Team 7 / Ana  ", "team-7-ana"),
        ("ÅSA", "sa"),
        ("...", "participant"),
    ],
)
def test_participant_becomes_a_safe_resource_name(raw, expected):
    config = load_config([], env={"PARTICIPANT": raw})

    assert config.participant == expected


def test_participant_defaults_to_the_os_user(monkeypatch):
    monkeypatch.setattr("getpass.getuser", lambda: "Sam.Lee")

    assert load_config([], env={}).participant == "sam-lee"


@pytest.mark.parametrize(
    "credentials, bearer, workspace_key",
    [
        ({"SN_API_KEY": "team-key"}, "Bearer team-key", None),
        ({"ORCA_API_KEY": "local-key"}, None, "local-key"),
        ({"ORCA_API_KEY": "local-key", "SN_API_KEY": "mcp-key"}, None, "local-key"),
    ],
)
def test_client_sends_exactly_one_registry_credential(monkeypatch, credentials, bearer, workspace_key):
    import httpx2
    from orca import Orca

    seen = []
    def respond(request):
        seen.append(request)
        return httpx2.Response(200, json={"data": [], "next_page": None})

    monkeypatch.setenv("ORCA_API_KEY", "ambient-key-must-not-be-used-as-bearer")
    monkeypatch.setattr("common.Orca", lambda **kwargs: Orca(
        **kwargs, http_client=httpx2.Client(transport=httpx2.MockTransport(respond))
    ))
    config = load_config([], env={"ORCA_BASE_URL": "http://127.0.0.1:8080", **credentials})
    with orca_client(config) as client:
        client.agents.list(limit=1)

    assert len(seen) == 1
    assert seen[0].headers.get("Authorization") == bearer
    assert seen[0].headers.get("x-api-key") == workspace_key


def test_client_explains_how_to_supply_a_missing_registry_credential():
    with pytest.raises(ConfigError, match="ORCA_API_KEY.*SN_API_KEY"):
        orca_client(load_config([], env={"ORCA_BASE_URL": "http://127.0.0.1:8080"}))
