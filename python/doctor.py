"""Check your laptop and your team card before the tutorial starts.

    python doctor.py             # laptop + .env + Agent Engine + Kafka + Schema Registry + MCP
    python doctor.py --offline   # laptop only (run this before the event)
    python doctor.py --agent-only  # laptop + Agent Engine (for ork local / L1)

Every failed check prints the fix.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
from dataclasses import dataclass
from typing import Any, Iterable
from urllib.parse import urlsplit

CARD = ("SN_API_KEY", "SN_SERVICE_ACCOUNT", "ORCA_BASE_URL", "KAFKA_BOOTSTRAP_SERVERS", "SCHEMA_REGISTRY_URL", "SN_MCP_URL", "LOGIN_TOPIC", "ORCA_MODEL")
SQL_FIELDS = ("account_id", "event_time", "ip_address", "result", "failure_reason")
MCP_TOOLS = ("sql_workspace_list_databases", "sql_workspace_query", "sql_workspace_insert_rows")
PACKAGES = {"orca": "runorca", "confluent_kafka": "confluent-kafka[avro]", "dotenv": "python-dotenv"}


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    fix: str = ""


# ------------------------------------------------------------- decisions --


def check_python(version: tuple) -> Check:
    ok = tuple(version[:2]) >= (3, 11)
    return Check("Python 3.11+", ok, "%d.%d" % tuple(version[:2]), "" if ok else "Install Python 3.11 or newer.")


def check_orca_base_url(url: str) -> Check:
    parts = urlsplit(url.strip())
    local_http = parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1")
    if not parts.netloc or (parts.scheme != "https" and not local_http):
        return Check("ORCA_BASE_URL", False, url, "Use the https:// registry endpoint from your team card, or http://127.0.0.1:8080 for ork local.")
    root = f"{parts.scheme}://{parts.netloc}"
    if parts.path.rstrip("/"):
        return Check("ORCA_BASE_URL", False, url, f"Use the host root only: ORCA_BASE_URL={root}")
    return Check("ORCA_BASE_URL", True, root)


def check_login_schema(fields: Iterable[str]) -> Check:
    present = set(fields)
    missing = [name for name in SQL_FIELDS if name not in present]
    if not missing:
        return Check("login topic schema", True, "has " + ", ".join(SQL_FIELDS))
    fix = "The SQL in sql/ expects these fields: ask a facilitator which schema your topic uses."
    if "result" in missing and "outcome" in present:
        fix = "Your topic names the login result `outcome`, not `result`: use `outcome` in sql/01 and sql/02 (and check its values)."
    return Check("login topic schema", False, "missing " + ", ".join(missing), fix)


def check_mcp_tools(names: Iterable[str]) -> Check:
    offered = set(names)
    missing = [tool for tool in MCP_TOOLS if tool not in offered]
    if not missing:
        return Check("MCP tools", True, ", ".join(MCP_TOOLS))
    return Check("MCP tools", False, "missing " + ", ".join(missing), "The MCP server does not offer these tools to your key: ask a facilitator.")


def parse_mcp_response(content_type: str, body: str, request_id: int) -> dict[str, Any]:
    """Pick the JSON-RPC reply to `request_id` out of a JSON or event-stream body."""
    if content_type.startswith("text/event-stream"):
        messages = [json.loads(line[len("data:") :]) for line in body.splitlines() if line.startswith("data:")]
    else:
        messages = [json.loads(body)]
    for message in messages:
        if message.get("id") == request_id:
            if "error" in message:
                raise RuntimeError(message["error"].get("message", "MCP error"))
            return message.get("result", {})
    raise RuntimeError(f"no reply to MCP request {request_id}")


def kafka_hint(error: str) -> str:
    text = error.lower()
    if "authentication" in text or "sasl" in text:
        return (
            "Kafka rejected the login. SN_SERVICE_ACCOUNT must be the full principal "
            "(<name>@<org>.auth.streamnative.cloud) and SN_API_KEY the raw key, with no 'token:' prefix."
        )
    if "authorization" in text:
        return "Your key logs in but may not use this topic: its rolebinding is missing. Ask a facilitator."
    if any(word in text for word in ("resolve", "transport", "timed out", "connect")):
        return "Cannot reach Kafka. Check KAFKA_BOOTSTRAP_SERVERS (host:port from your team card) and your network."
    return "See the error above, or ask a facilitator."


# ---------------------------------------------------------------- probes --


def check_packages(agent_only: bool = False) -> list[Check]:
    checks = []
    for module, package in PACKAGES.items():
        if agent_only and module == "confluent_kafka":
            continue
        found = importlib.util.find_spec(module) is not None
        checks.append(Check(f"package {package}", found, "", "" if found else "Run: pip install -r requirements.txt"))
    return checks


def check_cli_tools() -> list[Check]:
    """Only the CLI path needs these, so a missing tool is reported but never fails."""
    return [
        Check(f"{tool} (CLI path only)", True, "found" if shutil.which(tool) else "not found: fine unless you take the CLI path")
        for tool in ("ork", "jq")
    ]


def probe_orca(config: Any) -> Check:
    from orca import APIConnectionError, APIStatusError

    from common import orca_client

    try:
        orca_client(config).agents.list(limit=1)
    except APIStatusError as err:
        if err.status_code in (401, 403):
            fix = "The Agent Engine rejected the key. For ork local use its generated workspace key as ORCA_API_KEY; for a team card check SN_API_KEY and its rolebinding."
        elif err.status_code == 404:
            fix = "ORCA_BASE_URL is not an Agent Engine registry: copy the registry endpoint from your team card."
        else:
            fix = "Ask a facilitator."
        return Check("Agent Engine", False, f"HTTP {err.status_code}", fix)
    except APIConnectionError as err:
        return Check("Agent Engine", False, str(err), "Cannot reach ORCA_BASE_URL. Check the URL and your network.")
    return Check("Agent Engine", True, "API key accepted")


def probe_kafka(config: Any) -> Check:
    from confluent_kafka import KafkaException
    from confluent_kafka.admin import AdminClient

    errors: list[str] = []
    admin = AdminClient(
        {
            "bootstrap.servers": config["KAFKA_BOOTSTRAP_SERVERS"],
            "security.protocol": "SASL_SSL",
            "sasl.mechanisms": "PLAIN",
            "sasl.username": config["SN_SERVICE_ACCOUNT"],
            "sasl.password": config["SN_API_KEY"],
            "error_cb": lambda err: errors.append(str(err)),
        }
    )
    topic_name = config["LOGIN_TOPIC"]
    try:
        # Listing all existing topics avoids metadata requests that can auto-create a missing topic.
        topic = admin.list_topics(timeout=15).topics.get(topic_name)
    except KafkaException as err:
        reason = errors[0] if errors else str(err)
        return Check("Kafka", False, reason, kafka_hint(reason))
    if topic is None or topic.error is not None:
        reason = str(topic.error) if topic is not None else "not found"
        return Check("Kafka", False, f"{topic_name}: {reason}", kafka_hint(reason))
    return Check("Kafka", True, f"{topic_name} has {len(topic.partitions)} partition(s)")


def probe_schema_registry(config: Any) -> list[Check]:
    from confluent_kafka.schema_registry import SchemaRegistryClient

    subject = f"{config['LOGIN_TOPIC']}-value"
    registry = SchemaRegistryClient(
        {"url": config["SCHEMA_REGISTRY_URL"], "basic.auth.user.info": f"{config['SN_SERVICE_ACCOUNT']}:{config['SN_API_KEY']}"}
    )
    try:
        latest = registry.get_latest_version(subject)
    except Exception as err:  # SchemaRegistryError, or a connection error
        return [Check("Schema Registry", False, str(err), "Check SCHEMA_REGISTRY_URL; your key may lack Schema Registry read access.")]
    fields = [field["name"] for field in json.loads(latest.schema.schema_str)["fields"]]
    return [Check("Schema Registry", True, f"{subject} v{latest.version}"), check_login_schema(fields)]


def mcp_tool_names(url: str, token: str) -> list[str]:
    """Ask the MCP server which tools it offers: initialize, then tools/list."""
    import urllib.request

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}

    def post(payload: dict[str, Any]) -> dict[str, Any] | None:
        request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.headers.get("Mcp-Session-Id"):
                headers["Mcp-Session-Id"] = response.headers["Mcp-Session-Id"]
            body = response.read().decode()
            content_type = response.headers.get("Content-Type", "application/json")
        return parse_mcp_response(content_type, body, payload["id"]) if "id" in payload else None

    hello = {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "hello-doctor", "version": "1"}}
    init = post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": hello}) or {}
    headers["MCP-Protocol-Version"] = init.get("protocolVersion", hello["protocolVersion"])
    post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    names: list[str] = []
    cursor = None
    for request_id in range(2, 12):
        params = {"cursor": cursor} if cursor else {}
        page = post({"jsonrpc": "2.0", "id": request_id, "method": "tools/list", "params": params}) or {}
        names += [tool["name"] for tool in page.get("tools", [])]
        cursor = page.get("nextCursor")
        if not cursor:
            break
    return names


def probe_mcp(config: Any) -> Check:
    try:
        names = mcp_tool_names(config["SN_MCP_URL"], config["SN_API_KEY"])
    except Exception as err:  # HTTP errors, JSON-RPC errors, timeouts
        return Check("MCP server", False, str(err), "Check SN_MCP_URL, and that MCP is enabled for your key: ask a facilitator.")
    return check_mcp_tools(names)


# ------------------------------------------------------------------ main --


def run_checks(offline: bool, agent_only: bool = False) -> list[Check]:
    checks = [check_python(sys.version_info), *check_packages(agent_only), *check_cli_tools()]
    if offline or not all(check.ok for check in checks):
        return checks

    from common import load_config

    config = load_config([])
    required = ("ORCA_BASE_URL", "ORCA_MODEL") if agent_only else CARD
    missing = [name for name in required if name not in config.values]
    if agent_only and not any(name in config.values for name in ("ORCA_API_KEY", "SN_API_KEY")):
        missing.append("ORCA_API_KEY or SN_API_KEY")
    if missing:
        fix = "Copy .env.example to .env in the repo root and paste your team card."
        return [*checks, Check("team card (.env)", False, "missing " + ", ".join(missing), fix)]

    checks.append(Check("team card (.env)", True, f"participant: {config.participant}"))
    base_url = check_orca_base_url(config["ORCA_BASE_URL"])
    checks.append(base_url)
    if base_url.ok:
        checks.append(probe_orca(config))
    if agent_only:
        return checks
    checks.append(probe_kafka(config))
    checks += probe_schema_registry(config)
    checks.append(probe_mcp(config))
    return checks


def main() -> int:
    checks = run_checks(offline="--offline" in sys.argv[1:], agent_only="--agent-only" in sys.argv[1:])
    for check in checks:
        print(f"{'PASS' if check.ok else 'FAIL'}  {check.name:<32} {check.detail}")
        if not check.ok and check.fix:
            print(f"      fix: {check.fix}")
    failed = sum(not check.ok for check in checks)
    print("\nAll good: you're ready." if not failed else f"\n{failed} check(s) failed. Fix them, then run doctor again.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
