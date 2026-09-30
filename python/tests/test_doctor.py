"""doctor.py: the decisions behind each check (the network probes are exercised end to end)."""

import pytest

from doctor import check_login_schema, check_mcp_tools, check_orca_base_url, check_python, kafka_hint, parse_mcp_response


@pytest.mark.parametrize("url", ["https://ws.example.com", "https://ws.example.com/"])
def test_a_host_root_url_passes(url):
    assert check_orca_base_url(url).ok


@pytest.mark.parametrize("url", ["https://ws.example.com/v1", "https://ws.example.com/v1/registry", "https://ws.example.com/api/v1"])
def test_a_url_with_an_api_path_fails_and_suggests_the_host_root(url):
    check = check_orca_base_url(url)

    assert not check.ok
    assert "https://ws.example.com" in check.fix


def test_a_url_without_https_fails():
    assert not check_orca_base_url("ws.example.com").ok


def test_python_older_than_3_11_fails():
    assert check_python((3, 11, 4)).ok
    assert check_python((3, 14, 0)).ok
    assert not check_python((3, 10, 12)).ok


LOGIN_FIELDS = ["event_id", "event_time", "account_id", "ip_address", "result", "failure_reason", "auth_method"]


def test_the_topic_schema_has_every_field_the_sql_uses():
    assert check_login_schema(LOGIN_FIELDS).ok


def test_a_missing_field_is_named():
    check = check_login_schema([f for f in LOGIN_FIELDS if f != "ip_address"])

    assert not check.ok
    assert "ip_address" in check.detail


def test_an_outcome_field_instead_of_result_gets_a_specific_fix():
    fields = [f for f in LOGIN_FIELDS if f != "result"] + ["outcome"]

    check = check_login_schema(fields)

    assert not check.ok
    assert "outcome" in check.fix


def test_the_mcp_server_must_offer_the_three_tools_the_agent_uses():
    tools = ["sql_workspace_list_databases", "sql_workspace_query", "sql_workspace_insert_rows", "sncloud_context_whoami"]

    assert check_mcp_tools(tools).ok


def test_missing_mcp_tools_are_named():
    check = check_mcp_tools(["sql_workspace_query"])

    assert not check.ok
    assert "sql_workspace_list_databases" in check.detail
    assert "sql_workspace_insert_rows" in check.detail


def test_parses_a_plain_json_mcp_response():
    body = '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"sql_workspace_query"}]}}'

    assert parse_mcp_response("application/json", body, 2) == {"tools": [{"name": "sql_workspace_query"}]}


def test_parses_an_event_stream_mcp_response_and_picks_the_matching_id():
    body = (
        "event: message\n"
        'data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n'
        "event: message\n"
        'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"sql_workspace_query"}]}}\n\n'
    )

    assert parse_mcp_response("text/event-stream; charset=utf-8", body, 2) == {"tools": [{"name": "sql_workspace_query"}]}


def test_an_mcp_error_response_raises_with_its_message():
    body = '{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"forbidden: no MCP permission"}}'

    with pytest.raises(RuntimeError, match="no MCP permission"):
        parse_mcp_response("application/json", body, 2)


@pytest.mark.parametrize(
    "error, advice",
    [
        ("KafkaError{code=_AUTHENTICATION,val=-169,str=\"SASL authentication error: Authentication failed\"}", "SN_SERVICE_ACCOUNT"),
        ("KafkaError{code=TOPIC_AUTHORIZATION_FAILED,val=29,str=\"Broker: Topic authorization failed\"}", "rolebinding"),
        ("KafkaError{code=_TRANSPORT,val=-195,str=\"Failed to resolve 'bad-host:9093'\"}", "KAFKA_BOOTSTRAP_SERVERS"),
    ],
)
def test_kafka_errors_map_to_a_concrete_fix(error, advice):
    assert advice in kafka_hint(error)


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "[::1]"])
def test_local_http_agent_engine_is_accepted(host):
    assert check_orca_base_url(f"http://{host}:8080").ok


def test_non_local_http_still_requires_https():
    assert not check_orca_base_url("http://ws.example.com").ok


def test_local_api_path_suggests_the_local_host_root():
    check = check_orca_base_url("http://127.0.0.1:8080/v1")
    assert not check.ok
    assert "http://127.0.0.1:8080" in check.fix
