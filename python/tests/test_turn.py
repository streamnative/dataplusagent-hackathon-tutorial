"""run_turn: send one message and drive the session until the agent's turn ends."""

import pytest

from common import TurnError, run_turn
from fakes import FakeSessionEvents, client_with_events


def text(t: str) -> list[dict]:
    return [{"type": "text", "text": t}]


def idle(stop: str, event_ids: list[str] | None = None) -> dict:
    reason = {"type": stop, **({"event_ids": event_ids} if event_ids else {})}
    return {"id": f"evt_idle_{stop}", "type": "session.status_idle", "stop_reason": reason}


INSERT_CALL = {
    "id": "evt_tool_1",
    "type": "agent.mcp_tool_use",
    "name": "sql_workspace_insert_rows",
    "mcp_server_name": "streamnative",
    "input": {"table": "flagged_accounts", "rows": [{"account_id": "acct_9123"}]},
}


def drive(reactions, *, history=(), echo=True, confirm=None):
    events = FakeSessionEvents(reactions, history=history, echo_user_events=echo)
    lines: list[str] = []
    result = run_turn(client_with_events(events), "sess_1", "hi", confirm=confirm, out=lines.append)
    return result, lines, events


def test_returns_and_prints_the_agents_reply():
    result, lines, _ = drive([[{"id": "evt_a", "type": "agent.message", "content": text("Hello!")}, idle("end_turn")]])

    assert result.text == "Hello!"
    assert any("Hello!" in line for line in lines)


def test_opens_the_stream_before_sending_the_message():
    _, _, events = drive([[idle("end_turn")]])

    assert events.calls[0] == ("stream", "sess_1")
    assert events.calls[1] == (
        "send",
        "sess_1",
        [{"type": "user.message", "content": [{"type": "text", "text": "hi"}]}],
    )


def test_ignores_events_replayed_from_earlier_turns():
    history = [
        {"id": "evt_old_msg", "type": "agent.message", "content": text("old answer"), "processed_at": "2026-10-07T09:59:01.000Z"},
        {"id": "evt_old_idle", "type": "session.status_idle", "stop_reason": {"type": "end_turn"}, "processed_at": "2026-10-07T09:59:02.000Z"},
    ]
    reply = [{"id": "evt_new", "type": "agent.message", "content": text("new answer")}, idle("end_turn")]

    result, lines, _ = drive([reply], history=history)

    assert result.text == "new answer"
    assert not any("old answer" in line for line in lines)


def test_works_when_the_stream_does_not_echo_user_events():
    result, _, _ = drive([[{"id": "evt_a", "type": "agent.message", "content": text("Hi")}, idle("end_turn")]], echo=False)

    assert result.text == "Hi"


def test_prints_an_event_once_even_if_the_stream_repeats_it():
    msg = {"id": "evt_a", "type": "agent.message", "content": text("once")}

    _, lines, _ = drive([[msg, msg, idle("end_turn")]])

    assert sum("once" in line for line in lines) == 1


def test_shows_which_tool_ran_and_with_what_input():
    query = {
        "id": "evt_q",
        "type": "agent.mcp_tool_use",
        "name": "sql_workspace_query",
        "mcp_server_name": "streamnative",
        "input": {"sql": "SELECT * FROM login_failures"},
    }

    _, lines, _ = drive([[query, idle("end_turn")]])

    assert any("sql_workspace_query" in line and "SELECT * FROM login_failures" in line for line in lines)


def test_approval_sends_allow_for_the_blocked_tool_and_continues():
    seen = []

    def confirm(tool_use):
        seen.append(tool_use)
        return True

    reactions = [
        [INSERT_CALL, idle("requires_action", ["evt_tool_1"])],
        [{"id": "evt_done", "type": "agent.message", "content": text("Flagged acct_9123.")}, idle("end_turn")],
    ]

    result, _, events = drive(reactions, confirm=confirm)

    assert [t["name"] for t in seen] == ["sql_workspace_insert_rows"]
    assert events.calls[2] == (
        "send",
        "sess_1",
        [{"type": "user.tool_confirmation", "tool_use_id": "evt_tool_1", "result": "allow"}],
    )
    assert result.text == "Flagged acct_9123."


def test_denial_sends_deny_with_a_reason():
    reactions = [
        [INSERT_CALL, idle("requires_action", ["evt_tool_1"])],
        [{"id": "evt_ack", "type": "agent.message", "content": text("Understood, not flagged.")}, idle("end_turn")],
    ]

    _, _, events = drive(reactions, confirm=lambda _tool_use: False)

    sent = events.calls[2][2]
    assert sent[0]["type"] == "user.tool_confirmation"
    assert sent[0]["tool_use_id"] == "evt_tool_1"
    assert sent[0]["result"] == "deny"
    assert sent[0]["deny_message"]


def test_a_tool_waiting_for_approval_without_an_approver_is_an_error():
    with pytest.raises(TurnError, match="approv"):
        drive([[INSERT_CALL, idle("requires_action", ["evt_tool_1"])]])


def test_a_retryable_session_error_is_reported_but_the_turn_continues():
    retrying = {
        "id": "evt_err",
        "type": "session.error",
        "error": {"type": "overloaded_error", "message": "model busy"},
        "retry_status": {"will_retry": True},
    }

    result, lines, _ = drive([[retrying, {"id": "evt_a", "type": "agent.message", "content": text("ok")}, idle("end_turn")]])

    assert result.text == "ok"
    assert any("model busy" in line for line in lines)


def test_retries_exhausted_raises_with_the_last_error_message():
    fatal = {
        "id": "evt_err",
        "type": "session.error",
        "error": {"type": "invalid_request_error", "message": "model not found: nope-1"},
        "retry_status": {"will_retry": False},
    }

    with pytest.raises(TurnError, match="model not found: nope-1"):
        drive([[fatal, idle("retries_exhausted")]])


def test_a_stream_that_ends_mid_turn_is_an_error():
    with pytest.raises(TurnError, match="ended"):
        drive([[{"id": "evt_a", "type": "agent.message", "content": text("partial")}]])


def test_shows_a_tool_result_briefly():
    result_event = {
        "id": "evt_r",
        "type": "agent.mcp_tool_result",
        "mcp_tool_use_id": "evt_q",
        "is_error": False,
        "content": text("3 rows: acct_0042 failed=7"),
    }

    _, lines, _ = drive([[result_event, idle("end_turn")]])

    assert any("3 rows: acct_0042 failed=7" in line for line in lines)


def test_a_huge_tool_result_does_not_flood_the_terminal():
    result_event = {"id": "evt_r", "type": "agent.mcp_tool_result", "is_error": False, "content": text("x" * 5000)}

    _, lines, _ = drive([[result_event, idle("end_turn")]])

    assert all(len(line) < 300 for line in lines)


def test_a_failed_tool_call_is_labelled_as_an_error():
    failed = {"id": "evt_r", "type": "agent.mcp_tool_result", "is_error": True, "content": text("permission denied")}

    _, lines, _ = drive([[failed, idle("end_turn")]])

    assert any("error" in line and "permission denied" in line for line in lines)
    assert not any(line.startswith("[result]") for line in lines)


def test_events_without_a_timestamp_are_not_dropped():
    reply = {"id": "evt_a", "type": "agent.message", "content": text("still here"), "processed_at": None}

    result, _, _ = drive([[reply, idle("end_turn")]])

    assert result.text == "still here"


def test_nanosecond_timestamps_from_the_server_are_handled():
    # Assumption: the Agent Engine may emit more than six fractional digits.
    # datetime.fromisoformat accepts that from Python 3.11 on (hence the doctor's floor).
    history = [
        {"id": "evt_old", "type": "session.status_idle", "stop_reason": {"type": "end_turn"}, "processed_at": "2026-10-07T09:59:59.123456789Z"},
    ]
    reply = {"id": "evt_a", "type": "agent.message", "content": text("fine"), "processed_at": "2026-10-07T10:00:05.987654321Z"}

    result, _, _ = drive([[reply, {**idle("end_turn"), "processed_at": "2026-10-07T10:00:06.000000001Z"}]], history=history)

    assert result.text == "fine"
