"""seed.py: the login stream the Local course loads into your topic."""

import ipaddress
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from confluent_kafka import KafkaError, KafkaException
from fastavro import parse_schema
from fastavro.validation import validate

from seed import count_existing, events_in_topic, load_events, rebase_events

TOPIC = "security.login_events"
SCHEMA = parse_schema(json.loads((Path(__file__).resolve().parents[2] / "schemas" / "login_events.avsc").read_text()))
NOW = datetime(2026, 10, 7, 10, 30, tzinfo=timezone.utc)
NOW_MS = int(NOW.timestamp() * 1000)
# The ranges reserved for documentation (RFC 5737): no real host has these addresses.
DOCUMENTATION_RANGES = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")]


def test_every_seed_event_matches_the_topics_avro_schema():
    for record in load_events():
        assert validate(record, SCHEMA, raise_errors=True)


def test_the_seed_holds_one_account_under_attack():
    logins = [e for e in load_events() if e["account_id"] == "acct_0042"]

    assert sum(e["result"] == "FAILURE" for e in logins) == 5
    assert sum(e["result"] == "SUCCESS" for e in logins) == 2
    assert len({e["ip_address"] for e in logins}) == 2
    # The takeover: every failure comes before the attacker's success.
    attack = sorted((e for e in logins if e["scenario_id"] != "baseline"), key=lambda e: e["event_time"])
    assert [e["result"] for e in attack] == ["FAILURE"] * 5 + ["SUCCESS"]


def test_no_other_account_looks_like_a_takeover():
    by_account: dict[str, list[str]] = {}
    for event in load_events():
        by_account.setdefault(event["account_id"], []).append(event["result"])

    suspects = [account for account, results in by_account.items() if results.count("FAILURE") >= 5 and "SUCCESS" in results]

    assert suspects == ["acct_0042"]


def test_every_address_in_the_seed_is_from_a_documentation_range():
    for event in load_events():
        address = ipaddress.ip_address(event["ip_address"])
        assert any(address in network for network in DOCUMENTATION_RANGES), event["ip_address"]


def test_seeded_accounts_do_not_collide_with_injected_ones():
    # inject.py attacks acct_9000..acct_9999.
    assert not any(e["account_id"].startswith("acct_9") for e in load_events())


def test_rebasing_makes_the_newest_event_happen_now():
    rebased = rebase_events(load_events(), NOW)

    assert max(e["event_time"] for e in rebased) == NOW_MS


def test_rebasing_keeps_every_gap_between_events():
    original = load_events()
    rebased = rebase_events(original, NOW)
    shift = rebased[0]["event_time"] - original[0]["event_time"]

    assert all(after["event_time"] - before["event_time"] == shift for before, after in zip(original, rebased))
    assert all(after["ingested_at"] - before["ingested_at"] == shift for before, after in zip(original, rebased))


def test_rebasing_changes_nothing_but_the_two_timestamps():
    original = load_events()
    rebased = rebase_events(original, NOW)
    stable = lambda e: {k: v for k, v in e.items() if k not in ("event_time", "ingested_at")}  # noqa: E731

    assert [stable(e) for e in rebased] == [stable(e) for e in original]
    assert original == load_events()  # the input is not modified


def test_an_empty_topic_counts_no_events():
    assert events_in_topic([(0, 0)]) == 0


def test_events_are_counted_across_partitions_from_their_watermarks():
    assert events_in_topic([(0, 246), (10, 17)]) == 253


# ------------------------------------------------- what the topic holds now --


class FakeConsumer:
    """A Kafka consumer that knows one topic, or none, or cannot reach its broker."""

    def __init__(self, watermarks=None, *, unreachable=False):
        self.watermarks = watermarks  # {partition: (low, high)}; None when the topic is missing
        self.unreachable = unreachable
        self.closed = False

    def list_topics(self, timeout):
        if self.unreachable:
            raise KafkaException(KafkaError(KafkaError._TRANSPORT, "Failed to get metadata: Local: Broker transport failure"))
        topics = {} if self.watermarks is None else {TOPIC: SimpleNamespace(error=None, partitions=dict.fromkeys(self.watermarks))}
        return SimpleNamespace(topics=topics)

    def get_watermark_offsets(self, partition, timeout):
        return self.watermarks[partition.partition]

    def close(self):
        self.closed = True


def test_the_seed_counts_what_the_topic_already_holds():
    consumer = FakeConsumer({0: (0, 246)})

    assert count_existing(consumer, TOPIC) == 246
    assert consumer.closed


def test_a_missing_topic_stops_the_seed_and_points_at_lab_0():
    consumer = FakeConsumer()

    with pytest.raises(SystemExit) as stop:
        count_existing(consumer, TOPIC)

    assert "does not exist yet" in str(stop.value)
    assert "Lab 0" in str(stop.value)
    assert consumer.closed


def test_an_unreachable_broker_stops_the_seed_with_the_reason_and_a_next_step():
    consumer = FakeConsumer(unreachable=True)

    with pytest.raises(SystemExit) as stop:
        count_existing(consumer, TOPIC)

    message = str(stop.value)
    assert "Broker transport failure" in message
    assert "KafkaError{" not in message  # the reason, not the client's repr of it
    assert "python doctor.py" in message
    assert consumer.closed
