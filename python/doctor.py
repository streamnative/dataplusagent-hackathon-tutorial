"""Check your laptop and your .env before a lab.

    python doctor.py             # laptop + .env + Agent Engine + Kafka + Schema Registry + MCP
    python doctor.py --offline   # laptop only (run this before the event)
    python doctor.py --agent-only  # laptop + Agent Engine (enough for Lab 1)

It checks the stack your .env is for: your instance on StreamNative Cloud, or
the stack on your laptop. Every failed check prints the fix.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
from dataclasses import dataclass
from typing import Any, Callable, Iterable
from urllib.parse import urlsplit

CARD = ("SN_API_KEY", "SN_SERVICE_ACCOUNT", "ORCA_BASE_URL", "KAFKA_BOOTSTRAP_SERVERS", "SCHEMA_REGISTRY_URL", "SN_MCP_URL", "LOGIN_TOPIC", "ORCA_MODEL")
LOCAL = ("ORCA_API_KEY", "ORCA_BASE_URL", "KAFKA_BOOTSTRAP_SERVERS", "SCHEMA_REGISTRY_URL", "RW_MCP_URL", "RW_MCP_LOCAL_URL", "LOGIN_TOPIC", "ORCA_MODEL")
SQL_FIELDS = ("account_id", "event_time", "ip_address", "result", "failure_reason")
# The tools the agent definitions in agent/<stack>/ enable.
MCP_TOOLS = {
    "cloud": ("sql_workspace_list_databases", "sql_workspace_query", "sql_workspace_describe_table", "sql_workspace_insert_rows"),
    "local": ("run_select_query", "describe_table", "insert_multiple_rows"),
}
PACKAGES = {"orca": "runorca", "confluent_kafka": "confluent-kafka[avro]", "dotenv": "python-dotenv"}
START_LOCAL_STACK = "Start the streaming stack: docker compose -f local/compose.yaml up -d --wait"


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    fix: str = ""
    wait: bool = False  # not ready yet, and not your mistake: a later lab does it

    @property
    def label(self) -> str:
        return "PASS" if self.ok else "WAIT" if self.wait else "FAIL"


# ------------------------------------------------------------- decisions --


def required_for(stack: str) -> tuple[str, ...]:
    return LOCAL if stack == "local" else CARD


def check_python(version: tuple) -> Check:
    ok = tuple(version[:2]) >= (3, 11)
    return Check("Python 3.11+", ok, "%d.%d" % tuple(version[:2]), "" if ok else "Install Python 3.11 or newer.")


def check_orca_base_url(url: str) -> Check:
    parts = urlsplit(url.strip())
    local_http = parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1")
    if not parts.netloc or (parts.scheme != "https" and not local_http):
        return Check("ORCA_BASE_URL", False, url, "Use your agent workspace's https:// external endpoint (Cloud course, Lab 0), or http://127.0.0.1:8080 for ork local.")
    root = f"{parts.scheme}://{parts.netloc}"
    if parts.path.rstrip("/"):
        return Check("ORCA_BASE_URL", False, url, f"Use the host root only: ORCA_BASE_URL={root}")
    return Check("ORCA_BASE_URL", True, root)


def check_login_schema(fields: Iterable[str], stack: str = "cloud") -> Check:
    present = set(fields)
    missing = [name for name in SQL_FIELDS if name not in present]
    if not missing:
        return Check("login topic schema", True, "has " + ", ".join(SQL_FIELDS))
    fix = "The SQL in sql/ expects these fields: ask a facilitator which schema your topic uses."
    if "result" in missing and "outcome" in present:
        fix = (
            "Your topic names the login result `outcome`, not `result`: use `outcome` in "
            f"sql/{stack}/01_explore.sql and sql/{stack}/02_login_failures.sql (and check its values)."
        )
    return Check("login topic schema", False, "missing " + ", ".join(missing), fix)


def check_mcp_tools(names: Iterable[str], stack: str = "cloud") -> Check:
    wanted = MCP_TOOLS[stack]
    offered = set(names)
    missing = [tool for tool in wanted if tool not in offered]
    if not missing:
        return Check("MCP tools", True, ", ".join(wanted))
    if stack == "local":
        fix = "The agent definitions in agent/local/ need these tools: check the risingwave-mcp image tag in local/compose.yaml."
    else:
        fix = "The MCP server does not offer these tools to your key: ask a facilitator."
    return Check("MCP tools", False, "missing " + ", ".join(missing), fix)


def check_mcp_query(text: str) -> Check:
    """`SELECT 1` through the MCP server: one row back means it reaches RisingWave."""
    try:
        rows = json.loads(text)
    except ValueError:
        rows = None
    if isinstance(rows, list) and len(rows) == 1:
        return Check("RisingWave through MCP", True, "SELECT 1 returned a row")
    return Check("RisingWave through MCP", False, text[:200], f"The MCP server cannot query RisingWave. {START_LOCAL_STACK}")


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


def kafka_hint(error: str, stack: str = "cloud") -> str:
    text = error.lower()
    if stack == "local":
        if any(word in text for word in ("resolve", "transport", "timed out", "connect")):
            return f"Cannot reach Kafka on your laptop. {START_LOCAL_STACK}"
        return "The login topic is not there yet. Create it and seed it: Local course, Lab 0."
    if "authentication" in text or "sasl" in text:
        return (
            "Kafka rejected the login. SN_SERVICE_ACCOUNT must be the full principal "
            "(<name>@<org>.auth.streamnative.cloud) and SN_API_KEY the raw key, with no 'token:' prefix."
        )
    if "authorization" in text:
        return "Your key logs in but may not use this topic: its rolebinding is missing. Ask a facilitator."
    if any(word in text for word in ("resolve", "transport", "timed out", "connect")):
        return "Cannot reach Kafka. Check KAFKA_BOOTSTRAP_SERVERS (your Kafka cluster's host:port, Cloud course, Lab 0) and your network."
    if "not found" in text:
        return "The login topic is not there yet. Create it and load it: Cloud course, Lab 0."
    return "See the error above, or ask a facilitator."


def schema_registry_hint(error: str, stack: str = "cloud") -> str:
    if stack != "local":
        if "not found" in error.lower():
            return "The schema is registered when you load the topic: python seed.py (Cloud course, Lab 0)."
        return "Check SCHEMA_REGISTRY_URL; your key may lack Schema Registry read access."
    if "not found" in error.lower():
        return "The schema is registered when you seed the topic: python seed.py (Local course, Lab 0)."
    return f"Cannot reach Schema Registry on your laptop. {START_LOCAL_STACK}"


def mcp_headers(token: str | None) -> dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def summarize(checks: list[Check]) -> tuple[int, str]:
    """The exit code and the last line. A waiting check is not a failure."""
    failed = sum(check.label == "FAIL" for check in checks)
    waiting = sum(check.label == "WAIT" for check in checks)
    if failed:
        return 1, f"{failed} check(s) failed. Fix them, then run doctor again."
    if waiting:
        return 0, f"You're ready. {waiting} check(s) wait for a later lab."
    return 0, "All good: you're ready."


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
    """ork and jq run the checks in each lab; ork also does the first OAuth login. Reported, never failed."""
    notes = {"ork": "not found: install it for the lab checks and the first OAuth MCP login", "jq": "not found: install it for the lab checks"}
    return [Check(tool, True, "found" if shutil.which(tool) else notes[tool]) for tool in ("ork", "jq")]


def check_docker() -> Check:
    found = shutil.which("docker") is not None
    return Check("docker", found, "found" if found else "not found", "" if found else "The Local course runs in Docker: install Docker Desktop, or Docker Engine with Compose v2.")


def probe_orca(config: Any) -> Check:
    from orca import APIConnectionError, APIStatusError

    from common import orca_client

    local = config.stack == "local"
    try:
        orca_client(config).agents.list(limit=1)
    except APIStatusError as err:
        if err.status_code in (401, 403) and local:
            fix = "The key in .env does not match the running stack. Run local/write-env.sh; if it still fails, start over with local/down.sh --reset."
        elif err.status_code in (401, 403):
            fix = "The Agent Engine rejected the key. For ork local use its generated workspace key as ORCA_API_KEY; on StreamNative Cloud check SN_API_KEY and its rolebinding."
        elif err.status_code == 404:
            fix = "ORCA_BASE_URL is not an Agent Engine registry: use your agent workspace's external endpoint (Cloud course, Lab 0)."
        else:
            fix = "Ask a facilitator."
        return Check("Agent Engine", False, f"HTTP {err.status_code}", fix)
    except APIConnectionError as err:
        fix = "Start the Agent Engine: local/engine.sh" if local else "Cannot reach ORCA_BASE_URL. Check the URL and your network."
        return Check("Agent Engine", False, str(err), fix)
    return Check("Agent Engine", True, "API key accepted")


def probe_kafka(config: Any) -> Check:
    from confluent_kafka import KafkaException
    from confluent_kafka.admin import AdminClient

    from common import kafka_client_config

    errors: list[str] = []
    admin = AdminClient({**kafka_client_config(config), "error_cb": lambda err: errors.append(str(err))})
    topic_name = config["LOGIN_TOPIC"]
    try:
        # Listing all existing topics avoids metadata requests that can auto-create a missing topic.
        topic = admin.list_topics(timeout=15).topics.get(topic_name)
    except KafkaException as err:
        reason = errors[0] if errors else str(err)
        return Check("Kafka", False, reason, kafka_hint(reason, config.stack))
    if topic is None or topic.error is not None:
        reason = str(topic.error) if topic is not None else "not found"
        return Check("Kafka", False, f"{topic_name}: {reason}", kafka_hint(reason, config.stack))
    return Check("Kafka", True, f"{topic_name} has {len(topic.partitions)} partition(s)")


def probe_schema_registry(config: Any) -> list[Check]:
    from confluent_kafka.schema_registry import SchemaRegistryClient

    from common import schema_registry_config

    subject = f"{config['LOGIN_TOPIC']}-value"
    registry = SchemaRegistryClient(schema_registry_config(config))
    try:
        latest = registry.get_latest_version(subject)
    except Exception as err:  # SchemaRegistryError, or a connection error
        return [Check("Schema Registry", False, str(err), schema_registry_hint(str(err), config.stack))]
    fields = [field["name"] for field in json.loads(latest.schema.schema_str)["fields"]]
    return [Check("Schema Registry", True, f"{subject} v{latest.version}"), check_login_schema(fields, config.stack)]


def mcp_connect(url: str, token: str | None = None) -> Callable[[str, dict[str, Any]], dict[str, Any]]:
    """Open an MCP session over HTTP. Returns `request(method, params)`."""
    import urllib.request

    headers = mcp_headers(token)
    ids = iter(range(1, 1000))

    def post(payload: dict[str, Any]) -> dict[str, Any] | None:
        request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.headers.get("Mcp-Session-Id"):
                headers["Mcp-Session-Id"] = response.headers["Mcp-Session-Id"]
            body = response.read().decode()
            content_type = response.headers.get("Content-Type", "application/json")
        return parse_mcp_response(content_type, body, payload["id"]) if "id" in payload else None

    def request(method: str, params: dict[str, Any]) -> dict[str, Any]:
        return post({"jsonrpc": "2.0", "id": next(ids), "method": method, "params": params}) or {}

    hello = {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "hello-doctor", "version": "1"}}
    init = request("initialize", hello)
    headers["MCP-Protocol-Version"] = init.get("protocolVersion", hello["protocolVersion"])
    post({"jsonrpc": "2.0", "method": "notifications/initialized"})
    return request


def mcp_tool_names(url: str, token: str | None = None, *, request: Callable[..., dict[str, Any]] | None = None) -> list[str]:
    """Ask the MCP server which tools it offers: initialize, then tools/list."""
    request = request or mcp_connect(url, token)
    names: list[str] = []
    cursor = None
    for _ in range(10):
        page = request("tools/list", {"cursor": cursor} if cursor else {})
        names += [tool["name"] for tool in page.get("tools", [])]
        cursor = page.get("nextCursor")
        if not cursor:
            break
    return names


def probe_mcp(config: Any, *, client: Any = None, state: Any = None) -> Check:
    from common import mcp_auth_type, orca_client, state_for

    try:
        if mcp_auth_type(config) == "mcp_oauth":
            client = client or orca_client(config)
            state = state or state_for(config)
            vault_id = state.get("vault_id")
            later = "Nothing to do now: Lab 3 opens your browser to authorize the MCP server. Run doctor again after it."
            if not vault_id:
                return Check("MCP OAuth", False, "no tutorial vault yet", later, wait=True)
            credentials = client.vaults.credentials.list(vault_id).data
            credential = next((c for c in credentials if c.auth.type == "mcp_oauth"
                               and c.auth.mcp_server_url == config["SN_MCP_URL"] and not c.archived_at), None)
            if credential is None:
                return Check("MCP OAuth", False, "no matching OAuth credential", later, wait=True)
            result = client.vaults.credentials.validate(vault_id, credential.id)
            ok = result.status == "valid"
            fix = ""
            if result.status == "unknown":
                fix = "The MCP probe was inconclusive. Check Registry/MCP connectivity and rerun doctor; keep the existing credential."
            elif result.status == "invalid":
                fix = f"Reauthorize: ork agent vaults credentials archive {credential.id} --vault {vault_id}, then run the Lab 3 script again."
            return Check("MCP OAuth", ok, f"{result.status}: MCP initialization; the SQL tools are checked in Labs 3 and 4", fix)
        names = mcp_tool_names(config["SN_MCP_URL"], config["SN_API_KEY"])
    except Exception as err:  # HTTP errors, JSON-RPC errors, timeouts
        return Check("MCP server", False, str(err), "Check SN_MCP_URL and SN_MCP_AUTH; for OAuth, finish the Lab 3 browser login and verify the vault credential.")
    return check_mcp_tools(names)


def probe_local_mcp(config: Any) -> list[Check]:
    """The MCP server on your laptop, as your terminal reaches it. No credential."""
    try:
        request = mcp_connect(config["RW_MCP_LOCAL_URL"])
        tools = check_mcp_tools(mcp_tool_names(config["RW_MCP_LOCAL_URL"], request=request), "local")
        result = request("tools/call", {"name": "run_select_query", "arguments": {"query": "SELECT 1 AS ready"}})
    except Exception as err:  # HTTP errors, JSON-RPC errors, timeouts
        return [Check("MCP server", False, str(err), START_LOCAL_STACK)]
    text = "".join(block.get("text", "") for block in result.get("content", []) if isinstance(block, dict))
    return [tools, check_mcp_query(text)]


# ------------------------------------------------------------------ main --


def run_checks(offline: bool, agent_only: bool = False) -> list[Check]:
    checks = [check_python(sys.version_info), *check_packages(agent_only), *check_cli_tools()]
    if offline or not all(check.ok for check in checks):
        return checks

    from common import ConfigError, load_config, setup_hint

    config = load_config([])
    try:
        stack = config.stack
    except ConfigError as err:
        return [*checks, Check(".env", False, str(err), "Set TUTORIAL_STACK=cloud or TUTORIAL_STACK=local in .env, or remove the line.")]
    required = ("ORCA_BASE_URL", "ORCA_MODEL") if agent_only else required_for(stack)
    missing = [name for name in required if name not in config.values]
    if agent_only and not any(name in config.values for name in ("ORCA_API_KEY", "SN_API_KEY")):
        missing.append("ORCA_API_KEY or SN_API_KEY")
    if missing:
        return [*checks, Check(".env", False, "missing " + ", ".join(missing), setup_hint(config.values))]

    checks.append(Check(".env", True, f"{stack} stack, participant: {config.participant}"))
    if stack == "local":
        checks.append(check_docker())
    base_url = check_orca_base_url(config["ORCA_BASE_URL"])
    checks.append(base_url)
    if base_url.ok:
        checks.append(probe_orca(config))
    if agent_only:
        return checks
    checks.append(probe_kafka(config))
    checks += probe_schema_registry(config)
    if stack == "local":
        checks += probe_local_mcp(config)
    else:
        checks.append(probe_mcp(config))
    return checks


def main() -> int:
    checks = run_checks(offline="--offline" in sys.argv[1:], agent_only="--agent-only" in sys.argv[1:])
    for check in checks:
        print(f"{check.label}  {check.name:<32} {check.detail}")
        if not check.ok and check.fix:
            print(f"      {'next' if check.wait else 'fix'}: {check.fix}")
    code, verdict = summarize(checks)
    print(f"\n{verdict}")
    return code


if __name__ == "__main__":
    sys.exit(main())
