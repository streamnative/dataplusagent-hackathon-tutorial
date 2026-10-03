"""Load the login stream into your topic (Lab 0, in either course).

Replays data/login_events.jsonl: 246 synthetic logins at a fictional bank, with
their timestamps moved to now. One of the accounts in it is under attack.

    python seed.py
    python seed.py --force    # load another copy into a topic that already has events
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from common import REPO_ROOT, kafka_client_config, load_config, run_main
from inject import login_producer, publish

EVENTS_FILE = REPO_ROOT / "data" / "login_events.jsonl"
SCHEMA_FILE = REPO_ROOT / "schemas" / "login_events.avsc"


def load_events(path: Path = EVENTS_FILE) -> list[dict[str, Any]]:
    """One login event per line."""
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def rebase_events(events: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    """The same events, moved in time so the newest one happens now. Every gap is kept."""
    shift = int(now.timestamp() * 1000) - max(event["event_time"] for event in events)
    return [{**event, "event_time": event["event_time"] + shift, "ingested_at": event["ingested_at"] + shift} for event in events]


def events_in_topic(watermarks: Iterable[tuple[int, int]]) -> int:
    """How many events a topic holds, from each partition's (low, high) offsets."""
    return sum(high - low for low, high in watermarks)


def count_existing(consumer: Any, topic: str, stack: str = "local") -> int:
    """How many events the topic holds already. Stops the script when it cannot tell."""
    from confluent_kafka import KafkaException, TopicPartition

    try:
        # Listing every topic avoids a metadata request that could create a missing one.
        metadata = consumer.list_topics(timeout=15).topics.get(topic)
        if metadata is None or metadata.error is not None:
            course = "Local course" if stack == "local" else "Cloud course"
            raise SystemExit(f"The topic {topic} does not exist yet. Create it first: {course}, Lab 0.")
        return events_in_topic(consumer.get_watermark_offsets(TopicPartition(topic, p), timeout=15) for p in metadata.partitions)
    except KafkaException as err:
        reason = err.args[0].str() if err.args else str(err)
        raise SystemExit(f"Could not read {topic}: {reason}\nRun `python doctor.py` to check your setup.") from None
    finally:
        consumer.close()


def main() -> None:
    from confluent_kafka import Consumer

    config = load_config(["KAFKA_BOOTSTRAP_SERVERS", "SCHEMA_REGISTRY_URL", "LOGIN_TOPIC"])
    topic = config["LOGIN_TOPIC"]

    existing = count_existing(Consumer({**kafka_client_config(config), "group.id": "hello-seed"}), topic, config.stack)
    if existing and "--force" not in sys.argv[1:]:
        raise SystemExit(f"{topic} already holds {existing} events, so it is seeded. To load another copy anyway: python seed.py --force")

    events = rebase_events(load_events(), datetime.now(timezone.utc))
    # Registering the schema is what lets RisingWave decode the topic.
    errors = publish(login_producer(config, schema=SCHEMA_FILE.read_text()), topic, events)
    if errors:
        raise SystemExit(f"Could not write to {topic}: {errors[0]}\nRun `python doctor.py` to check your setup.")
    accounts = len({event["account_id"] for event in events})
    print(f"Loaded {len(events)} logins for {accounts} accounts into {topic}.")


if __name__ == "__main__":
    run_main(main)
