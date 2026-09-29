/**
 * Test oracle: which permission a tool ends up with, per the Agent Engine docs.
 *
 * Resolution order (docs: Permission policies, "How a policy is resolved"):
 *   1. a `configs` entry naming the tool,
 *   2. the toolset's `default_config`,
 *   3. the toolset default, which is `always_ask` for `mcp_toolset`.
 * A tool from an MCP server the agent does not declare is refused outright.
 */

type ToolConfig = { name?: string; enabled?: boolean; permission_policy?: { type: string } | null };
type Toolset = { type: string; mcp_server_name?: string; default_config?: ToolConfig | null; configs?: ToolConfig[] };

export function effectivePolicy(agent: { tools: unknown[] }, server: string, tool: string): string {
  for (const toolset of agent.tools as Toolset[]) {
    if (toolset.type !== 'mcp_toolset' || toolset.mcp_server_name !== server) continue;
    const fallback = toolset.default_config ?? {};
    const named = (toolset.configs ?? []).find((c) => c.name === tool) ?? {};
    const enabled = named.enabled ?? fallback.enabled ?? true;
    if (!enabled) return 'disabled';
    return (named.permission_policy ?? fallback.permission_policy ?? { type: 'always_ask' }).type;
  }
  return 'disabled';
}
