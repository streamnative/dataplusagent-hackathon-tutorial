import { Config, agentParams, loadLayer } from '../src/common.js';

export const MCP_URL = 'https://mcp.example.com/mcp/x/o-test/sqlworkspace/ws-1';

export function params(layer: string) {
  return agentParams(loadLayer(layer), new Config({ ORCA_MODEL: 'claude-sonnet-4-6', SN_MCP_URL: MCP_URL }, 'jane'));
}
