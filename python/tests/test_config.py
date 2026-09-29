"""load_config: read the team card (.env) and fail with every problem at once."""

import pytest

from common import ConfigError, load_config

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
