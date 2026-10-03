"""run_turn: send one message and drive the session until the agent's turn ends."""

from types import SimpleNamespace

import pytest

from common import TurnError, run_turn
from fakes import FakeSessionEvents, OrkLocalSessionEvents, client_with_events


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
    assert any("model busy" in line and "(retrying)" in line for line in lines)


def test_a_retry_reported_inside_the_error_is_marked_as_retrying_too():
    # The shape `ork local` sends: the retry status sits inside `error`.
    retrying = {
        "id": "evt_err",
        "type": "session.error",
        "error": {"type": "unknown_error", "message": "server_error (status 502)", "retry_status": {"type": "retrying"}},
    }

    _, lines, _ = drive([[retrying, {"id": "evt_a", "type": "agent.message", "content": text("ok")}, idle("end_turn")]])

    assert any("server_error (status 502)" in line and "(retrying)" in line for line in lines)


def test_an_exhausted_retry_is_not_marked_as_retrying():
    exhausted = {
        "id": "evt_err",
        "type": "session.error",
        "error": {"type": "unknown_error", "message": "API key is invalid.", "retry_status": {"type": "exhausted"}},
    }

    events = FakeSessionEvents([[exhausted, idle("retries_exhausted")]])
    lines: list[str] = []

    with pytest.raises(TurnError, match="API key is invalid."):
        run_turn(client_with_events(events), "sess_1", "hi", out=lines.append)

    assert any("API key is invalid." in line for line in lines)
    assert not any("(retrying)" in line for line in lines)


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


def test_the_sdks_warning_about_keep_alive_frames_stays_out_of_the_lab_output():
    # The local engine keeps a quiet stream open with empty frames. The SDK skips
    # each one and logs a warning, which would land between the lines of a turn.
    import logging

    assert not logging.getLogger("orca._streaming").isEnabledFor(logging.WARNING)
    assert logging.getLogger("orca._streaming").isEnabledFor(logging.ERROR)


# ------------------------------------------- send first: the `ork local` engine --
#
# That engine answers a stream opened on a quiet session only at its next
# keep-alive, 15 seconds later. With send_first=True the turn speaks first and
# then follows the session from its start.


def drive_local(reactions, *, confirm=None):
    events = OrkLocalSessionEvents(reactions)
    lines: list[str] = []
    result = run_turn(client_with_events(events), "sess_1", "hi", confirm=confirm, out=lines.append, send_first=True)
    return result, lines, events


def test_send_first_sends_the_message_then_follows_the_session_from_its_start():
    _, _, events = drive_local([[idle("end_turn")]])

    assert events.calls[0] == (
        "send",
        "sess_1",
        [{"type": "user.message", "content": [{"type": "text", "text": "hi"}]}],
    )
    # From the start of the session, not from the live edge: whatever the agent
    # said before the stream opened is replayed, not lost.
    assert events.calls[1] == ("stream", "sess_1", "0")


def test_send_first_returns_and_prints_the_agents_reply():
    result, lines, _ = drive_local([[{"id": "evt_a", "type": "agent.message", "content": text("Hello!")}, idle("end_turn")]])

    assert result.text == "Hello!"
    assert any("Hello!" in line for line in lines)


def test_send_first_shows_only_the_second_turns_reply_on_the_second_turn():
    events = OrkLocalSessionEvents(
        [
            [{"id": "evt_a1", "type": "agent.message", "content": text("first answer")}, idle("end_turn")],
            [{"id": "evt_a2", "type": "agent.message", "content": text("second answer")}, {**idle("end_turn"), "id": "evt_idle_2"}],
        ]
    )
    client = client_with_events(events)
    run_turn(client, "sess_1", "one", out=lambda _line: None, send_first=True)
    lines: list[str] = []

    result = run_turn(client, "sess_1", "two", out=lines.append, send_first=True)

    assert result.text == "second answer"
    assert not any("first answer" in line for line in lines)


def test_send_first_does_not_answer_an_approval_that_an_earlier_turn_left_open():
    events = OrkLocalSessionEvents(
        [
            # The first turn stops at a request for approval, and nobody answers it.
            [{**INSERT_CALL, "id": "evt_old_tool"}, {**idle("requires_action", ["evt_old_tool"]), "id": "evt_old_wait"}],
            [{"id": "evt_a", "type": "agent.message", "content": text("done")}, idle("end_turn")],
        ]
    )
    client = client_with_events(events)
    with pytest.raises(TurnError, match="approv"):
        run_turn(client, "sess_1", "one", out=lambda _line: None, send_first=True)
    asked = []

    result = run_turn(client, "sess_1", "two", confirm=lambda tool_use: asked.append(tool_use) or True, out=lambda _line: None, send_first=True)

    assert result.text == "done"
    assert asked == []


def test_send_first_approval_sends_allow_and_continues():
    reactions = [
        [INSERT_CALL, idle("requires_action", ["evt_tool_1"])],
        [{"id": "evt_done", "type": "agent.message", "content": text("Flagged acct_9123.")}, {**idle("end_turn"), "id": "evt_idle_2"}],
    ]

    result, _, events = drive_local(reactions, confirm=lambda _tool_use: True)

    assert events.calls[2] == (
        "send",
        "sess_1",
        [{"type": "user.tool_confirmation", "tool_use_id": "evt_tool_1", "result": "allow"}],
    )
    assert result.text == "Flagged acct_9123."


def test_send_first_treats_an_unconfirmed_message_as_an_error_not_a_hang():
    events = OrkLocalSessionEvents([[idle("end_turn")]])
    events.send = lambda session_id, *, events: SimpleNamespace(data=[])

    with pytest.raises(TurnError, match="did not confirm"):
        run_turn(client_with_events(events), "sess_1", "hi", out=lambda _line: None, send_first=True)


def test_the_default_order_also_works_on_that_engine_it_only_waits_longer():
    events = OrkLocalSessionEvents([[{"id": "evt_a", "type": "agent.message", "content": text("Hello!")}, idle("end_turn")]])

    result = run_turn(client_with_events(events), "sess_1", "hi", out=lambda _line: None)

    assert result.text == "Hello!"
    assert [call[0] for call in events.calls] == ["stream", "send"]
