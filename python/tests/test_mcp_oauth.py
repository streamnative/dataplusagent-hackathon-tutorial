"""OAuth delegation, reuse and doctor: no live browser or credentials required."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from common import Config, ConfigError, State, authorize_mcp, ensure_vault
from doctor import probe_mcp
from fakes import fake_client

URL = "https://mcp.example.com/mcp"


def config(**overrides):
    return Config(values={"ORCA_BASE_URL": "https://registry.example.com", "SN_API_KEY": "registry-secret",
                          "SN_MCP_URL": URL, **overrides}, participant="jane")


@pytest.fixture
def state(tmp_path):
    return State(tmp_path / "jane.json")


def seed(client, state, auth_type="mcp_oauth", url=URL, archived=False):
    vault = client.vaults.create(display_name="test")
    state.set("vault_id", vault.id)
    credential = SimpleNamespace(id="cred_oauth", auth=SimpleNamespace(type=auth_type, mcp_server_url=url), archived_at="old" if archived else None)
    client.vaults.credentials.store[vault.id] = [credential]
    return vault.id


@pytest.mark.parametrize("local", [False, True])
def test_oauth_uses_ork_without_secret_arguments(monkeypatch, local):
    runner = Mock(return_value=SimpleNamespace(returncode=0))
    monkeypatch.setattr("common.subprocess.run", runner)
    monkeypatch.setenv("ORCA_API_KEY", "stale-local")
    monkeypatch.setenv("ORCA_ACCESS_TOKEN", "stale-bearer")
    cfg = config(SN_MCP_OAUTH_ISSUER="https://auth.example.com/", SN_MCP_OAUTH_SCOPE="openid offline_access",
                 **({"ORCA_API_KEY": "local-secret"} if local else {}))
    authorize_mcp("vlt_1", cfg)
    args = runner.call_args.args[0]
    env = runner.call_args.kwargs["env"]
    assert args == ["ork", "agent", "vaults", "credentials", "create", "--vault", "vlt_1", "--display-name", "streamnative-mcp",
                    "--mcp-server-url", URL, "-o", "json", "--oauth-issuer", "https://auth.example.com/", "--oauth-scope", "openid offline_access"]
    assert "secret" not in " ".join(args)
    assert env["ORCA_REGISTRY_URL"] == "https://registry.example.com"
    assert env.get("ORCA_API_KEY") == ("local-secret" if local else None)
    assert env.get("ORCA_ACCESS_TOKEN") == (None if local else "registry-secret")


def test_default_oauth_creates_vault_then_delegates(monkeypatch, state):
    client = fake_client()
    authorize = Mock()
    monkeypatch.setattr("common.authorize_mcp", authorize)
    vault_id = ensure_vault(client, state, "hello-vault-jane", config())
    authorize.assert_called_once_with(vault_id, config())
    assert not any(c[0] == "create" for c in client.vaults.credentials.calls)
    assert state.get("vault_id") == vault_id
    assert "registry-secret" not in state.path.read_text()


def test_existing_oauth_needs_no_ork(monkeypatch, state):
    client = fake_client()
    vault_id = seed(client, state)
    authorize = Mock()
    monkeypatch.setattr("common.authorize_mcp", authorize)
    assert ensure_vault(client, state, "hello-vault-jane", config()) == vault_id
    authorize.assert_not_called()


@pytest.mark.parametrize("auth_type,url,archived", [("static_bearer", URL, False), ("mcp_oauth", URL + "-other", False), ("mcp_oauth", URL, True)])
def test_wrong_type_url_or_archived_credential_is_not_reused(monkeypatch, state, auth_type, url, archived):
    client = fake_client()
    vault_id = seed(client, state, auth_type, url, archived)
    authorize = Mock()
    monkeypatch.setattr("common.authorize_mcp", authorize)
    ensure_vault(client, state, "hello-vault-jane", config())
    authorize.assert_called_once_with(vault_id, config())
    archives = [c for c in client.vaults.credentials.calls if c[0] == "archive"]
    assert len(archives) == (1 if auth_type == "static_bearer" and url == URL and not archived else 0)


@pytest.mark.parametrize("failure", [FileNotFoundError(), SimpleNamespace(returncode=1)])
def test_oauth_failures_stop_without_static_fallback(monkeypatch, state, failure):
    runner = Mock(side_effect=failure) if isinstance(failure, Exception) else Mock(return_value=failure)
    monkeypatch.setattr("common.subprocess.run", runner)
    client = fake_client()
    with pytest.raises(ConfigError):
        ensure_vault(client, state, "hello-vault-jane", config())
    assert not any(c[0] == "create" for c in client.vaults.credentials.calls)


def test_invalid_auth_mode_fails_before_resources(state):
    client = fake_client()
    with pytest.raises(ConfigError, match="SN_MCP_AUTH"):
        ensure_vault(client, state, "test", config(SN_MCP_AUTH="typo"))
    assert client.vaults.calls == []


@pytest.mark.parametrize("status,ok", [("valid", True), ("invalid", False), ("unknown", False)])
def test_doctor_validates_vault_oauth_not_service_account_key(monkeypatch, state, status, ok):
    client = fake_client()
    vault_id = seed(client, state)
    client.vaults.credentials.validate = Mock(return_value=SimpleNamespace(status=status))
    direct = Mock(side_effect=AssertionError("must not send SN_API_KEY to OAuth MCP"))
    monkeypatch.setattr("doctor.mcp_tool_names", direct)
    check = probe_mcp(config(), client=client, state=state)
    assert check.ok is ok
    assert "initialization" in check.detail
    if status == "unknown":
        assert "keep the existing credential" in check.fix
    if status == "invalid":
        assert "credentials archive cred_oauth" in check.fix
    client.vaults.credentials.validate.assert_called_once_with(vault_id, "cred_oauth")
    direct.assert_not_called()


def test_doctor_before_first_oauth_login_gives_setup_hint(state):
    check = probe_mcp(config(), client=fake_client(), state=state)
    assert not check.ok
    assert "Run L3" in check.fix
