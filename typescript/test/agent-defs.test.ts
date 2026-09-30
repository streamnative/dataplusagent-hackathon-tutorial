/** agentParams: turn agent/<layer>.json into the arguments for agents.create/update. */

import type { AgentCreateParams, AgentUpdateParams } from '@runorca/orca-sdk';
import { describe, expect, it } from 'vitest';

import { Config, ConfigError, agentParams, loadLayer } from '../src/common.js';
import { effectivePolicy } from './policy.js';

const MCP_URL = 'https://mcp.example.com/mcp/x/o-test/sqlworkspace/ws-1';

function config(overrides: Record<string, string> = {}): Config {
  return new Config({ ORCA_MODEL: 'claude-sonnet-4-6', SN_MCP_URL: MCP_URL, ...overrides }, 'jane');
}

describe('agentParams', () => {
  it.each(['l1-hello', 'l3-live-context', 'l4-act'])('%s produces exactly the fields the SDK accepts', (layer) => {
    const params = agentParams(loadLayer(layer), config());

    // Checked by `npm run typecheck`: the params fit the SDK's create and update types.
    const create: AgentCreateParams = params;
    const update: AgentUpdateParams = { version: 1, ...params };
    expect(create).toBe(params);
    expect(update.version).toBe(1);
    // The layer's own bookkeeping fields (layer, summary) must not reach the API.
    expect(Object.keys(params).sort()).toEqual(['mcp_servers', 'metadata', 'model', 'name', 'system', 'tools']);
  });

  it('names the agent after the participant', () => {
    expect(agentParams(loadLayer('l1-hello'), config()).name).toBe('hello-agent-jane');
  });

  it('takes the model from the config', () => {
    expect(agentParams(loadLayer('l1-hello'), config({ ORCA_MODEL: 'claude-sonnet-5' })).model).toBe('claude-sonnet-5');
  });

  it('L1 explicitly clears tools and MCP servers', () => {
    // Updates are partial: an omitted field keeps its old value, so going back to
    // L1 after L3 must send empty lists to detach the MCP server.
    const params = agentParams(loadLayer('l1-hello'), config());

    expect(params.tools).toEqual([]);
    expect(params.mcp_servers).toEqual([]);
  });

  it('takes the MCP server URL from the team card', () => {
    const params = agentParams(loadLayer('l3-live-context'), config());

    expect(params.mcp_servers).toEqual([{ name: 'streamnative', type: 'url', url: MCP_URL }]);
  });

  it('a placeholder without a value is a config error', () => {
    const noUrl = new Config({ ORCA_MODEL: 'claude-sonnet-4-6' }, 'jane');

    expect(() => agentParams(loadLayer('l3-live-context'), noUrl)).toThrow(ConfigError);
    expect(() => agentParams(loadLayer('l3-live-context'), noUrl)).toThrow(/SN_MCP_URL/);
  });

  it.each([
    ['l1-hello', '457f86a77738415f'],
    ['l3-live-context', 'ac4d0b08aca3f336'],
    ['l4-act', '8d424c704af22671'],
  ])('%s fingerprint matches the Python and CLI paths (%s)', (layer, expected) => {
    // Same fingerprint everywhere, so switching languages does not bump the agent's version.
    expect(agentParams(loadLayer(layer), config()).metadata.definition_sha).toBe(expected);
  });

  it.each([
    ['l3-live-context', 'sql_workspace_list_databases', 'always_allow'],
    ['l3-live-context', 'sql_workspace_query', 'always_allow'],
    ['l3-live-context', 'sql_workspace_describe_table', 'disabled'],
    ['l3-live-context', 'sql_workspace_insert_rows', 'disabled'],
    ['l3-live-context', 'sql_workspace_delete_rows', 'disabled'],
    ['l3-live-context', 'kafka_client_produce', 'disabled'],
    ['l4-act', 'sql_workspace_query', 'always_allow'],
    ['l4-act', 'sql_workspace_describe_table', 'always_allow'],
    ['l4-act', 'sql_workspace_insert_rows', 'always_ask'],
    ['l4-act', 'sql_workspace_delete_rows', 'disabled'],
    ['l4-act', 'sql_workspace_create_materialized_view', 'disabled'],
    ['l4-act', 'kafka_client_produce', 'disabled'],
  ])('%s gives %s the permission %s', (layer, tool, expected) => {
    const params = agentParams(loadLayer(layer), config());

    expect(effectivePolicy(params, 'streamnative', tool)).toBe(expected);
  });
});
