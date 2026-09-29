"""Test oracle: which permission a tool ends up with, per the Agent Engine docs.

Resolution order (docs: Permission policies, "How a policy is resolved"):
  1. a `configs` entry naming the tool,
  2. the toolset's `default_config`,
  3. the toolset default, which is `always_ask` for `mcp_toolset`.
A tool from an MCP server the agent does not declare is refused outright.
"""

from __future__ import annotations

from typing import Any


def effective_policy(agent: dict[str, Any], server: str, tool: str) -> str:
    for toolset in agent.get("tools", []):
        if toolset.get("type") != "mcp_toolset" or toolset.get("mcp_server_name") != server:
            continue
        default = toolset.get("default_config") or {}
        named = next((c for c in toolset.get("configs", []) if c.get("name") == tool), {})
        enabled = named.get("enabled", default.get("enabled", True))
        if not enabled:
            return "disabled"
        policy = named.get("permission_policy") or default.get("permission_policy") or {"type": "always_ask"}
        return policy["type"]
    return "disabled"
