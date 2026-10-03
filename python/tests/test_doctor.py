"""doctor.py: the decisions behind each check (the network probes are exercised end to end)."""

import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from doctor import (
    Check,
    check_login_schema,
    check_mcp_query,
    check_mcp_tools,
    check_orca_base_url,
    check_python,
    kafka_hint,
    mcp_headers,
    parse_mcp_response,
    probe_orca,
    required_for,
    schema_registry_hint,
    summarize,
)


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


REPO = Path(__file__).resolve().parents[2]
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


@pytest.mark.parametrize("stack", ["cloud", "local"])
def test_the_outcome_fix_names_sql_files_that_exist_for_the_stack(stack):
    fields = [f for f in LOGIN_FIELDS if f != "result"] + ["outcome"]

    named = re.findall(r"sql/[\w/.]+\.sql", check_login_schema(fields, stack).fix)

    assert len(named) == 2
    assert all(name.startswith(f"sql/{stack}/") and (REPO / name).is_file() for name in named)


def test_the_mcp_server_must_offer_the_three_tools_the_agent_uses():
    tools = ["sql_workspace_list_databases", "sql_workspace_query", "sql_workspace_describe_table", "sql_workspace_insert_rows", "sncloud_context_whoami"]

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


# ------------------------------------------------------------ the two stacks --


def test_the_cloud_stack_needs_the_team_card():
    required = required_for("cloud")

    assert {"SN_API_KEY", "SN_SERVICE_ACCOUNT", "SN_MCP_URL"} <= set(required)
    assert "RW_MCP_URL" not in required


def test_the_local_stack_needs_no_team_card_values():
    required = required_for("local")

    assert {"ORCA_API_KEY", "KAFKA_BOOTSTRAP_SERVERS", "SCHEMA_REGISTRY_URL", "RW_MCP_URL", "RW_MCP_LOCAL_URL"} <= set(required)
    assert not any(name.startswith("SN_") for name in required)


def test_the_local_mcp_server_must_offer_the_tools_the_local_agent_uses():
    offered = ["run_select_query", "describe_table", "insert_multiple_rows", "drop_table", "list_databases"]

    assert check_mcp_tools(offered, "local").ok


def test_missing_local_mcp_tools_are_named_and_the_fix_is_local():
    check = check_mcp_tools(["run_select_query"], "local")

    assert not check.ok
    assert "describe_table" in check.detail
    assert "insert_multiple_rows" in check.detail
    assert "facilitator" not in check.fix


def test_a_select_through_mcp_that_returns_a_row_passes():
    assert check_mcp_query('[\n  {\n    "ready": 1\n  }\n]').ok


@pytest.mark.parametrize("text", ["Error executing query: connection refused", "[]", "not json"])
def test_a_select_through_mcp_that_returns_no_row_fails_with_what_came_back(text):
    check = check_mcp_query(text)

    assert not check.ok
    assert text in check.detail


@pytest.mark.parametrize(
    "error, advice",
    [
        ("KafkaError{code=_TRANSPORT,val=-195,str=\"127.0.0.1:29092/bootstrap: Connect to ipv4#127.0.0.1:29092 failed: Connection refused\"}", "local/compose.yaml"),
        ("not found", "Lab 0"),
    ],
)
def test_local_kafka_errors_point_at_the_local_stack(error, advice):
    hint = kafka_hint(error, "local")

    assert advice in hint
    assert "facilitator" not in hint
    assert "team card" not in hint


def test_a_local_schema_that_is_not_registered_yet_points_at_the_seeder():
    hint = schema_registry_hint("Subject 'security.login_events-value' not found. (HTTP status code 404, SR code 40401)", "local")

    assert "python seed.py" in hint
    assert "Lab 0" in hint


def test_an_unreachable_local_schema_registry_points_at_the_streaming_stack():
    hint = schema_registry_hint("[Errno 61] Connection refused", "local")

    assert "local/compose.yaml" in hint
    assert "seed" not in hint


@pytest.mark.parametrize("error", ["[Errno 61] Connection refused", "Unauthorized (HTTP status code 401, SR code 401)"])
def test_cloud_schema_registry_errors_point_at_the_schema_registry_url(error):
    hint = schema_registry_hint(error)

    assert "SCHEMA_REGISTRY_URL" in hint
    assert "compose" not in hint


# On StreamNative Cloud each participant creates and loads their own topic.


def test_a_cloud_topic_that_is_not_there_yet_points_at_lab_0():
    hint = kafka_hint("security.login_events: not found", "cloud")

    assert "Cloud course, Lab 0" in hint
    assert "facilitator" not in hint


def test_a_cloud_schema_that_is_not_registered_yet_points_at_the_seeder():
    # What StreamNative Cloud's registry says: it names the subject with its namespace.
    hint = schema_registry_hint("Subject 'public/default/security.login_events-value' not found. (HTTP status code 404, SR code 40401)")

    assert "python seed.py" in hint
    assert "Cloud course, Lab 0" in hint


@pytest.mark.parametrize("hint", [
    kafka_hint("Failed to resolve kafka.example.com:9093", "cloud"),
    check_orca_base_url("http://ws.example.com").fix,
])
def test_cloud_fixes_name_your_instance_not_a_team_card(hint):
    assert "team card" not in hint


@pytest.mark.parametrize("status", [401, 404])
def test_the_agent_engine_fixes_for_the_cloud_course_name_no_team_card(monkeypatch, status):
    import httpx2
    from orca import APIStatusError

    request = httpx2.Request("GET", "https://ws.example.com/v1/agents")
    error = APIStatusError("refused", response=httpx2.Response(status, request=request), body=None)

    class Agents:
        def list(self, limit):
            raise error

    monkeypatch.setattr("common.orca_client", lambda config: SimpleNamespace(agents=Agents()))
    check = probe_orca(SimpleNamespace(stack="cloud"))

    assert not check.ok
    assert "team card" not in check.fix


def test_the_mcp_probe_sends_a_bearer_token_only_when_it_has_one():
    assert mcp_headers("the-token")["Authorization"] == "Bearer the-token"
    assert "Authorization" not in mcp_headers(None)


# ------------------------------------------------------------- the verdict --


def test_all_checks_passing_is_a_zero_exit():
    code, verdict = summarize([Check("a", True), Check("b", True)])

    assert code == 0
    assert "ready" in verdict


def test_a_failed_check_is_a_nonzero_exit_and_is_counted():
    code, verdict = summarize([Check("a", True), Check("b", False, "boom", "fix it")])

    assert code == 1
    assert "1 check(s) failed" in verdict


def test_a_waiting_check_does_not_fail_the_doctor():
    waiting = Check("MCP OAuth", False, "no tutorial vault yet", "Lab 3 authorizes it.", wait=True)

    code, verdict = summarize([Check("a", True), waiting])

    assert code == 0
    assert "1 check(s) wait" in verdict


def test_a_failure_wins_over_a_waiting_check():
    waiting = Check("MCP OAuth", False, wait=True)

    code, verdict = summarize([Check("a", False), waiting])

    assert code == 1
    assert "1 check(s) failed" in verdict


@pytest.mark.parametrize("check, label", [(Check("a", True), "PASS"), (Check("a", False), "FAIL"), (Check("a", False, wait=True), "WAIT")])
def test_each_check_is_labelled(check, label):
    assert check.label == label
