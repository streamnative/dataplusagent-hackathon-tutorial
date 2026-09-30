"""build_burst: the brute-force-then-success login burst inject.py produces."""

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from fastavro import parse_schema
from fastavro.validation import validate

from inject import build_burst, new_account_id, publish

SCHEMA = parse_schema(json.loads((Path(__file__).resolve().parents[2] / "schemas" / "login_events.avsc").read_text()))
NOW = datetime(2026, 10, 7, 10, 30, tzinfo=timezone.utc)


def burst():
    return build_burst("acct_9123", "203.0.113.77", NOW)


def test_every_event_matches_the_topics_avro_schema():
    for record in burst():
        assert validate(record, SCHEMA, raise_errors=True)


def test_six_failed_logins_then_one_success():
    assert [r["result"] for r in burst()] == ["FAILURE"] * 6 + ["SUCCESS"]


def test_all_from_one_account_and_one_new_ip():
    records = burst()

    assert {r["account_id"] for r in records} == {"acct_9123"}
    assert {r["ip_address"] for r in records} == {"203.0.113.77"}


def test_events_are_in_time_order_with_unique_ids():
    records = burst()
    times = [r["event_time"] for r in records]

    assert times == sorted(times)
    assert len(set(times)) == len(records)
    assert len({r["event_id"] for r in records}) == len(records)


def test_only_the_failures_carry_a_failure_reason():
    records = burst()

    assert all(r["failure_reason"] for r in records[:-1])
    assert records[-1]["failure_reason"] is None


def test_injected_accounts_do_not_collide_with_the_preloaded_ones():
    # The preload uses acct_0001..acct_0500-ish; injected ids live in 9000-9999.
    ids = {new_account_id() for _ in range(50)}

    assert all(re.fullmatch(r"acct_9\d{3}", i) for i in ids)
    assert len(ids) > 1


class FakeProducer:
    """The two methods of confluent_kafka's SerializingProducer that inject.py uses."""

    def __init__(self, raise_on_produce=None, delivery_error=None, undelivered=0):
        self.produced = []
        self._raise = raise_on_produce
        self._delivery_error = delivery_error
        self._undelivered = undelivered
        self._callbacks = []

    def produce(self, topic, key=None, value=None, on_delivery=None):
        if self._raise is not None:
            raise self._raise
        self.produced.append((topic, key, value))
        self._callbacks.append(on_delivery)

    def flush(self, timeout=None):
        for callback in self._callbacks:
            callback(self._delivery_error, None)
        return self._undelivered


def test_publish_writes_every_record_keyed_by_account():
    producer = FakeProducer()

    errors = publish(producer, "security.login_events", "acct_9123", burst())

    assert errors == []
    assert len(producer.produced) == 7
    assert {(topic, key) for topic, key, _ in producer.produced} == {("security.login_events", "acct_9123")}


def test_a_schema_registry_failure_is_reported_instead_of_raised():
    from confluent_kafka.error import ValueSerializationError

    producer = FakeProducer(raise_on_produce=ValueSerializationError(Exception("Subject 'security.login_events-value' not found")))

    errors = publish(producer, "security.login_events", "acct_9123", burst())

    assert any("not found" in e for e in errors)


def test_a_delivery_failure_is_reported():
    producer = FakeProducer(delivery_error="Broker: Topic authorization failed")

    assert publish(producer, "t", "acct_9123", burst()) == ["Broker: Topic authorization failed"]


def test_events_still_queued_after_the_timeout_are_reported():
    assert publish(FakeProducer(undelivered=3), "t", "acct_9123", burst()) != []
