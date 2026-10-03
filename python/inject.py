"""Inject a brute-force login burst into the login topic.

Six failed logins from a new IP address, then a success: the classic
account-takeover pattern. The materialized view login_failures picks it up
within seconds, so the next time you ask, your agent sees it.

    python inject.py
"""

from __future__ import annotations

import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from common import Config, kafka_client_config, load_config, run_main, schema_registry_config

FAILURES = 6


def new_account_id() -> str:
    """An account id outside the preloaded range, so it is easy to spot."""
    return f"acct_9{random.randint(0, 999):03d}"


def new_ip() -> str:
    """An address from TEST-NET-3, the range reserved for documentation."""
    return f"203.0.113.{random.randint(2, 254)}"


def build_burst(account_id: str, ip_address: str, now: datetime) -> list[dict[str, Any]]:
    """Six failed logins from one IP address, then a success, two seconds apart."""
    records = []
    for attempt in range(FAILURES + 1):
        success = attempt == FAILURES
        millis = int((now + timedelta(seconds=2 * attempt)).timestamp() * 1000)
        records.append(
            {
                "event_id": str(uuid.uuid4()),
                "event_type": "LOGIN_ATTEMPT",
                "event_time": millis,
                "ingested_at": millis,
                "schema_version": "1.0",
                "tenant_id": "aegis_financial",
                "scenario_id": "hello_world_injection",
                "account_id": account_id,
                "session_id": f"sess_inject_{uuid.uuid4().hex[:8]}",
                "device_id": "device_inject_0001",
                "ip_address": ip_address,
                "country": "RO",
                "region": "Bucharest",
                "city": "Bucharest",
                "latitude": 44.4268,
                "longitude": 26.1025,
                "result": "SUCCESS" if success else "FAILURE",
                "auth_method": "PASSWORD",
                "failure_reason": None if success else "INVALID_PASSWORD",
                "user_agent": "python-requests/2.32",
            }
        )
    return records


def publish(producer: Any, topic: str, records: list[dict[str, Any]]) -> list[str]:
    """Write the records, each keyed by its account, and wait for Kafka to confirm them.

    Returns what went wrong, if anything.
    """
    from confluent_kafka import KafkaException

    errors: list[str] = []

    def delivered(err: Any, _msg: Any) -> None:
        if err is not None and str(err) not in errors:
            errors.append(str(err))

    try:
        for record in records:
            # Serializing looks the schema up in Schema Registry, so it can fail here too.
            producer.produce(topic, key=record["account_id"], value=record, on_delivery=delivered)
        undelivered = producer.flush(30)
    except KafkaException as err:
        return [str(err)]
    if undelivered and not errors:
        errors.append(f"{undelivered} event(s) still queued after 30 seconds")
    return errors


def login_producer(config: Config, *, schema: str | None = None) -> Any:
    """A producer of Avro login events.

    By default it writes with the schema the topic already has and never registers
    a new one. Pass `schema` to register it first: that is how seed.py fills a new topic.
    """
    from confluent_kafka import SerializingProducer
    from confluent_kafka.schema_registry import SchemaRegistryClient
    from confluent_kafka.schema_registry.avro import AvroSerializer
    from confluent_kafka.serialization import StringSerializer

    registry = SchemaRegistryClient(schema_registry_config(config))
    if schema is None:
        serializer = AvroSerializer(registry, conf={"auto.register.schemas": False, "use.latest.version": True})
    else:
        serializer = AvroSerializer(registry, schema)
    return SerializingProducer(
        {
            **kafka_client_config(config),
            "enable.idempotence": False,
            "key.serializer": StringSerializer("utf_8"),
            "value.serializer": serializer,
        }
    )


def main() -> None:
    config = load_config(["KAFKA_BOOTSTRAP_SERVERS", "SCHEMA_REGISTRY_URL", "LOGIN_TOPIC"])
    topic = config["LOGIN_TOPIC"]
    producer = login_producer(config)

    account_id, ip_address = new_account_id(), new_ip()
    errors = publish(producer, topic, build_burst(account_id, ip_address, datetime.now(timezone.utc)))
    if errors:
        raise SystemExit(f"Could not write to {topic}: {errors[0]}\nRun `python doctor.py` to check your Kafka access.")
    print(f"Injected {FAILURES} failed logins + 1 success for {account_id} from {ip_address} into {topic}.")
    print(f"Ask your agent again, or run this SQL:  SELECT * FROM login_failures WHERE account_id = '{account_id}';")


if __name__ == "__main__":
    run_main(main)
