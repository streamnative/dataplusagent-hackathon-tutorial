/** TUTORIAL_STACK: a team card on StreamNative Cloud, or the whole stack on your laptop. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { AgentCreateParams, AgentUpdateParams } from '@runorca/orca-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Config,
  ConfigError,
  State,
  agentParams,
  ensureAgent,
  kafkaClientConfig,
  loadConfig,
  loadLayer,
  mcpVaultIds,
  openSession,
  schemaRegistryConfig,
  stateFor,
} from '../src/common.js';
import { fakeClient } from './fakes.js';
import { effectivePolicy } from './policy.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const CLOUD = {
  SN_API_KEY: 'the-api-key',
  SN_SERVICE_ACCOUNT: 'team-07@o-test.auth.streamnative.cloud',
  KAFKA_BOOTSTRAP_SERVERS: 'kafka.example.com:9093',
  SCHEMA_REGISTRY_URL: 'https://sr.example.com',
  SN_MCP_URL: 'https://mcp.example.com/mcp',
  SN_MCP_AUTH: 'static_bearer',
  ORCA_MODEL: 'claude-sonnet-4-6',
};
const LOCAL = {
  TUTORIAL_STACK: 'local',
  KAFKA_BOOTSTRAP_SERVERS: '127.0.0.1:29092',
  SCHEMA_REGISTRY_URL: 'http://127.0.0.1:18081',
  RW_MCP_URL: 'http://risingwave-mcp:8000/mcp',
  ORCA_MODEL: 'claude-sonnet-4-6',
};

const config = (values: Record<string, string>) => new Config(values, 'jane');

function without(values: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => key !== name));
}

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected a ConfigError');
}

describe('the switch', () => {
  it('a team card without the switch is the cloud stack', () => {
    expect(config(CLOUD).stack).toBe('cloud');
  });

  it('the local stack is chosen in the .env', () => {
    expect(config(LOCAL).stack).toBe('local');
  });

  it('an unknown stack is a config error', () => {
    expect(messageOf(() => config({ TUTORIAL_STACK: 'laptop' }).stack)).toContain('TUTORIAL_STACK');
  });

  it('each stack remembers its ids in its own file', () => {
    expect(basename(stateFor(config(CLOUD)).path)).toBe('jane.json');
    expect(basename(stateFor(config(LOCAL)).path)).toBe('jane.local.json');
  });
});

describe('Kafka and Schema Registry', () => {
  it('the cloud stack reaches Kafka with SASL over TLS', () => {
    expect(kafkaClientConfig(config(CLOUD))).toEqual({
      brokers: ['kafka.example.com:9093'],
      ssl: true,
      sasl: { mechanism: 'plain', username: 'team-07@o-test.auth.streamnative.cloud', password: 'the-api-key' },
    });
  });

  it('the local stack reaches Kafka in plaintext without credentials', () => {
    expect(kafkaClientConfig(config(LOCAL))).toEqual({ brokers: ['127.0.0.1:29092'] });
  });

  it('a list of bootstrap servers becomes a list of brokers', () => {
    const servers = { ...LOCAL, KAFKA_BOOTSTRAP_SERVERS: 'kafka-1.example.com:9093, kafka-2.example.com:9093,' };

    expect(kafkaClientConfig(config(servers)).brokers).toEqual(['kafka-1.example.com:9093', 'kafka-2.example.com:9093']);
  });

  it('the cloud Schema Registry uses the service account', () => {
    expect(schemaRegistryConfig(config(CLOUD))).toEqual({
      host: 'https://sr.example.com',
      auth: { username: 'team-07@o-test.auth.streamnative.cloud', password: 'the-api-key' },
    });
  });

  it('the local Schema Registry needs no credentials', () => {
    expect(schemaRegistryConfig(config(LOCAL))).toEqual({ host: 'http://127.0.0.1:18081' });
  });

  it('a cloud card without the service account names what is missing', () => {
    const card = config(without(CLOUD, 'SN_SERVICE_ACCOUNT'));

    expect(messageOf(() => kafkaClientConfig(card))).toContain('SN_SERVICE_ACCOUNT');
    expect(messageOf(() => schemaRegistryConfig(card))).toContain('SN_SERVICE_ACCOUNT');
  });
});

describe('hints', () => {
  it('without a stack, the hint names both ways to get a .env file', () => {
    const message = messageOf(() => loadConfig(['ORCA_BASE_URL'], {}));

    expect(message).toContain('.env.cloud.example');
    expect(message).toContain('local/write-env.sh');
  });

  it('on the local stack, the hint is to write the .env file again', () => {
    const message = messageOf(() => loadConfig(['ORCA_BASE_URL'], { TUTORIAL_STACK: 'local' }));

    expect(message).toContain('local/write-env.sh');
    expect(message).not.toContain('team card');
  });

  it('a value read without checking for it first gets the same hint', () => {
    const message = messageOf(() => config({ TUTORIAL_STACK: 'local' }).get('ORCA_BASE_URL'));

    expect(message).toContain('ORCA_BASE_URL');
    expect(message).toContain('local/write-env.sh');
  });

  it('a missing placeholder on the local stack points at write-env', () => {
    const noUrl = config(without(LOCAL, 'RW_MCP_URL'));

    expect(messageOf(() => agentParams(loadLayer('l3-live-context', 'local'), noUrl))).toMatch(/RW_MCP_URL.*local\/write-env\.sh/);
  });
});

describe('local agent definitions', () => {
  it.each(['l1-hello', 'l3-live-context', 'l4-act'])('local %s produces exactly the fields the SDK accepts', (layer) => {
    const params = agentParams(loadLayer(layer, 'local'), config(LOCAL));

    // Checked by `npm run typecheck`: the params fit the SDK's create and update types.
    const create: AgentCreateParams = params;
    const update: AgentUpdateParams = { version: 1, ...params };
    expect(create).toBe(params);
    expect(update.version).toBe(1);
    expect(Object.keys(params).sort()).toEqual(['mcp_servers', 'metadata', 'model', 'name', 'system', 'tools']);
  });

  it('the local agent talks to the RisingWave MCP server', () => {
    const params = agentParams(loadLayer('l3-live-context', 'local'), config(LOCAL));

    expect(params.mcp_servers).toEqual([{ name: 'risingwave', type: 'url', url: 'http://risingwave-mcp:8000/mcp' }]);
  });

  it.each([
    ['l3-live-context', 'run_select_query', 'always_allow'],
    ['l3-live-context', 'describe_table', 'disabled'],
    ['l3-live-context', 'insert_multiple_rows', 'disabled'],
    ['l3-live-context', 'drop_table', 'disabled'],
    ['l3-live-context', 'execute_ddl_statement', 'disabled'],
    ['l4-act', 'run_select_query', 'always_allow'],
    ['l4-act', 'describe_table', 'always_allow'],
    ['l4-act', 'insert_multiple_rows', 'always_ask'],
    ['l4-act', 'insert_single_row', 'disabled'],
    ['l4-act', 'delete_rows', 'disabled'],
    ['l4-act', 'drop_table', 'disabled'],
    ['l4-act', 'execute_ddl_statement', 'disabled'],
  ])('local %s gives %s the permission %s', (layer, tool, expected) => {
    const params = agentParams(loadLayer(layer, 'local'), config(LOCAL));

    expect(effectivePolicy(params, 'risingwave', tool)).toBe(expected);
  });

  it('the two stacks do not share a definition fingerprint', () => {
    const cloud = agentParams(loadLayer('l3-live-context', 'cloud'), config(CLOUD));
    const local = agentParams(loadLayer('l3-live-context', 'local'), config(LOCAL));

    expect(cloud.metadata.definition_sha).not.toBe(local.metadata.definition_sha);
  });

  it.each([
    ['l1-hello', '457f86a77738415f'],
    ['l3-live-context', 'bc4fde88405b950e'],
    ['l4-act', 'db2876f6ae6d41f8'],
  ])('local %s fingerprint matches the Python and CLI paths (%s)', (layer, expected) => {
    // Same fingerprint everywhere, so switching languages does not bump the agent's version.
    expect(agentParams(loadLayer(layer, 'local'), config(LOCAL)).metadata.definition_sha).toBe(expected);
  });
});

describe('vaults and sessions', () => {
  let state: State;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    state = new State(join(mkdtempSync(join(tmpdir(), 'hello-stack-')), 'jane.json'));
  });

  it('on the cloud stack, the MCP credential goes in a vault', async () => {
    const client = fakeClient();

    const vaultIds = await mcpVaultIds(client, state, config(CLOUD));

    expect(vaultIds).toEqual([state.get('vault_id')]);
    expect(client.vaults.credentials.calls.filter((c) => c[0] === 'create')).toHaveLength(1);
  });

  it('the local MCP server takes no credential, so there is no vault', async () => {
    const client = fakeClient();

    expect(await mcpVaultIds(client, state, config(LOCAL))).toEqual([]);
    expect(client.vaults.calls).toEqual([]);
    expect(state.get('vault_id')).toBeNull();
  });

  it('a session is pinned to the agent version and remembered', async () => {
    const client = fakeClient();
    const agent = await ensureAgent(client, state, agentParams(loadLayer('l1-hello'), config(CLOUD)));

    const session = await openSession(client, state, 'env_1', agent, 'L1: hello');

    expect(client.sessions.calls).toEqual([
      ['create', { environment_id: 'env_1', agent: { type: 'agent', id: agent.id, version: 1 }, title: 'L1: hello' }],
    ]);
    expect(state.get('session_id')).toBe(session.id);
  });

  it('a session gets vault_ids only when there is a vault', async () => {
    const client = fakeClient();
    const agent = await ensureAgent(client, state, agentParams(loadLayer('l1-hello'), config(CLOUD)));

    await openSession(client, state, 'env_1', agent, 'L3: live context', { vaultIds: ['vlt_1'] });
    await openSession(client, state, 'env_1', agent, 'L3: live context', { vaultIds: [] });

    expect(client.sessions.calls[0][1].vault_ids).toEqual(['vlt_1']);
    expect(Object.keys(client.sessions.calls[1][1])).not.toContain('vault_ids');
  });

  it('the newest session replaces the remembered one', async () => {
    const client = fakeClient();
    const agent = await ensureAgent(client, state, agentParams(loadLayer('l1-hello'), config(CLOUD)));
    const first = await openSession(client, state, 'env_1', agent, 'L1: hello');

    const second = await openSession(client, state, 'env_1', agent, 'L1: hello');

    expect(first.id).not.toBe(second.id);
    expect(state.get('session_id')).toBe(second.id);
  });

  it('cloud OAuth still delegates to ork', async () => {
    const oauth = { ...without(CLOUD, 'SN_MCP_AUTH'), ORCA_BASE_URL: 'https://registry.example.com' };

    const vaultIds = await mcpVaultIds(fakeClient(), state, config(oauth));

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnSync).mock.calls[0][0]).toBe('ork');
    expect(vaultIds).toEqual([state.get('vault_id')]);
  });
});
