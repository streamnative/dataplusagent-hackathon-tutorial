/** ensure*: create Agent Engine resources once, then reuse or update them. */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { State, ensureAgent, ensureEnvironment, ensureVault } from '../src/common.js';
import { fakeClient, makeAgent } from './fakes.js';
import { MCP_URL, params } from './helpers.js';

let dir: string;
let state: State;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hello-state-'));
  state = new State(join(dir, 'jane.json'));
});

describe('ensureAgent', () => {
  it('first run creates the agent and remembers it', async () => {
    const client = fakeClient();

    const agent = await ensureAgent(client, state, params('l1-hello'));

    expect(agent.version).toBe(1);
    expect(client.agents.calls.map((c) => c[0])).toEqual(['create']);
    expect(existsSync(join(dir, 'jane.json'))).toBe(true);
    expect(new State(join(dir, 'jane.json')).get('agent_id')).toBe(agent.id);
  });

  it('rerunning a layer does not create a new version', async () => {
    const client = fakeClient();
    await ensureAgent(client, state, params('l1-hello'));

    const agent = await ensureAgent(client, state, params('l1-hello'));

    expect(agent.version).toBe(1);
    expect(client.agents.calls.map((c) => c[0])).not.toContain('update');
  });

  it('the next layer updates the same agent to a new version', async () => {
    const client = fakeClient();
    const first = await ensureAgent(client, state, params('l1-hello'));

    const upgraded = await ensureAgent(client, state, params('l3-live-context'));

    expect(upgraded.id).toBe(first.id);
    expect(upgraded.version).toBe(2);
    const update = client.agents.calls.find((c) => c[0] === 'update')!;
    expect((update[2] as { version: number }).version).toBe(1);
    expect(upgraded.mcp_servers[0].url).toBe(MCP_URL);
  });

  it('a remembered agent that no longer exists is recreated', async () => {
    const client = fakeClient();
    state.set('agent_id', 'agent_gone');

    const agent = await ensureAgent(client, state, params('l1-hello'));

    expect(agent.id).not.toBe('agent_gone');
    expect(state.get('agent_id')).toBe(agent.id);
  });

  it('an archived agent is not reused', async () => {
    const client = fakeClient();
    client.agents.store.set('agent_old', makeAgent('agent_old', 3, params('l1-hello'), true));
    state.set('agent_id', 'agent_old');

    const agent = await ensureAgent(client, state, params('l1-hello'));

    expect(agent.id).not.toBe('agent_old');
  });
});

describe('ensureEnvironment', () => {
  it('is created once and reused', async () => {
    const client = fakeClient();

    const first = await ensureEnvironment(client, state, 'hello-env-jane');
    const second = await ensureEnvironment(client, state, 'hello-env-jane');

    expect(first).toBe(second);
    expect(client.environments.calls.filter((c) => c[0] === 'create')).toHaveLength(1);
  });

  it('a reserved name gets a fresh suffix', async () => {
    const client = fakeClient(['hello-env-jane']);

    const environmentId = await ensureEnvironment(client, state, 'hello-env-jane');

    expect(client.environments.store.get(environmentId)!.name).toMatch(/^hello-env-jane-[0-9a-f]{4}$/);
  });
});

describe('ensureVault', () => {
  it('gets one bearer credential for the MCP server', async () => {
    const client = fakeClient();

    const vaultId = await ensureVault(client, state, 'hello-vault-jane', MCP_URL, 'the-api-key');

    expect(client.vaults.credentials.calls.filter((c) => c[0] === 'create')).toEqual([
      ['create', vaultId, { type: 'static_bearer', mcp_server_url: MCP_URL, token: 'the-api-key' }, 'streamnative-mcp'],
    ]);
  });

  it('reuses an existing credential for the same server', async () => {
    const client = fakeClient();
    const first = await ensureVault(client, state, 'hello-vault-jane', MCP_URL, 'the-api-key');

    const second = await ensureVault(client, state, 'hello-vault-jane', MCP_URL, 'the-api-key');

    expect(first).toBe(second);
    expect(client.vaults.credentials.calls.filter((c) => c[0] === 'create')).toHaveLength(1);
  });

  it('gives a new MCP URL its own credential', async () => {
    const client = fakeClient();
    await ensureVault(client, state, 'hello-vault-jane', MCP_URL, 'the-api-key');

    await ensureVault(client, state, 'hello-vault-jane', `${MCP_URL}-v2`, 'the-api-key');

    const urls = client.vaults.credentials.calls
      .filter((c) => c[0] === 'create')
      .map((c) => (c[2] as { mcp_server_url: string }).mcp_server_url);
    expect(urls).toEqual([MCP_URL, `${MCP_URL}-v2`]);
  });
});
