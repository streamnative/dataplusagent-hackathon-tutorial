/** The small helpers the layer scripts share: chat loop, approval prompt, cleanup, errors. */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APIConnectionError, AuthenticationError } from '@runorca/orca-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Config, ConfigError, State, TurnError, askHuman, chat, cleanup, ensureAgent, ensureEnvironment, ensureVault, runMain } from '../src/common.js';
import { FakeSessionEvents, OrkLocalSessionEvents, clientWithEvents, fakeClient, type RawEvent } from './fakes.js';
import { MCP_URL, params } from './helpers.js';

function reply(t: string): RawEvent[] {
  return [
    { id: `evt_${t}`, type: 'agent.message', content: [{ type: 'text', text: t }] },
    { id: `evt_idle_${t}`, type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ];
}

const quiet = () => {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chat', () => {
  it('keeps asking until the participant enters nothing', async () => {
    const events = new FakeSessionEvents([reply('first'), reply('second')]);
    const answers = ['and now?', ''];

    await chat(clientWithEvents(events), 'sess_1', 'who is under attack?', { ask: async () => answers.shift()!, out: quiet });

    const sent = events.calls
      .filter((c) => c[0] === 'send')
      .map((c) => ((c[2] as Array<{ content: Array<{ text: string }> }>)[0].content[0].text));
    expect(sent).toEqual(['who is under attack?', 'and now?']);
  });

  it('sends first on every turn when asked to', async () => {
    const events = new OrkLocalSessionEvents([reply('first'), reply('second')]);
    const answers = ['and now?', ''];
    const shown: string[] = [];

    await chat(clientWithEvents(events), 'sess_1', 'who is under attack?', {
      ask: async () => answers.shift()!,
      out: (line) => shown.push(line),
      sendFirst: true,
    });

    expect(events.calls.map((call) => call[0])).toEqual(['send', 'stream', 'send', 'stream']);
    expect(shown.filter((line) => line.startsWith('[agent]'))).toEqual(['[agent]  first', '[agent]  second']);
  });
});

describe('askHuman', () => {
  it.each([
    ['y', true],
    ['YES', true],
    [' yes ', true],
    ['', false],
    ['n', false],
    ['nope', false],
  ])('typing %j approves: %s', async (typed, allowed) => {
    const toolUse = { id: 'evt_t', name: 'sql_workspace_insert_rows', input: { rows: [{ account_id: 'acct_9123' }] } };
    const shown: string[] = [];

    expect(await askHuman(toolUse, { ask: async () => typed, out: (l) => shown.push(l) })).toBe(allowed);
    expect(shown.some((line) => line.includes('sql_workspace_insert_rows'))).toBe(true);
    expect(shown.some((line) => line.includes('acct_9123'))).toBe(true);
  });
});

describe('cleanup', () => {
  it('archives the agent and environment, deletes the vault, and forgets the ids', async () => {
    const client = fakeClient();
    const dir = mkdtempSync(join(tmpdir(), 'hello-state-'));
    const state = new State(join(dir, 'jane.json'));
    const agent = await ensureAgent(client, state, params('l1-hello'));
    const environmentId = await ensureEnvironment(client, state, 'hello-env-jane');
    const vaultId = await ensureVault(client, state, 'hello-vault-jane', new Config({ SN_MCP_AUTH: 'static_bearer', SN_MCP_URL: MCP_URL, SN_API_KEY: 'key' }, 'jane'));

    await cleanup(client, state, { out: quiet });

    expect(client.agents.store.get(agent.id)!.archived_at).not.toBeNull();
    expect(client.environments.store.get(environmentId)!.archived_at).not.toBeNull();
    expect(client.environments.calls).not.toContainEqual(['delete', environmentId]);
    expect(client.vaults.store.has(vaultId)).toBe(false);
    expect(existsSync(join(dir, 'jane.json'))).toBe(false);
  });

  it('tolerates resources that are already gone', async () => {
    const client = fakeClient();
    const dir = mkdtempSync(join(tmpdir(), 'hello-state-'));
    const state = new State(join(dir, 'jane.json'));
    state.set('agent_id', 'agent_gone');
    state.set('environment_id', 'env_gone');
    state.set('vault_id', 'vlt_gone');

    await cleanup(client, state, { out: quiet });

    expect(existsSync(join(dir, 'jane.json'))).toBe(false);
  });
});

describe('runMain', () => {
  class Exited extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`);
    }
  }

  async function exitMessage(failure: Error): Promise<{ code: number; message: string }> {
    const printed: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code ?? 0);
    }) as typeof process.exit);

    let code = -1;
    try {
      await runMain(async () => {
        throw failure;
      });
    } catch (err) {
      if (!(err instanceof Exited)) throw err;
      code = err.code;
    }
    return { code, message: printed.join('\n') };
  }

  it.each([
    [new ConfigError('Missing SN_API_KEY.'), 'Missing SN_API_KEY.'],
    [new TurnError('The agent stopped (retries_exhausted): model not found'), 'model not found'],
    [new AuthenticationError(401, { message: 'invalid token' }, 'invalid token', new Headers()), 'doctor'],
  ])('exits 1 with a readable message for %s', async (failure, expected) => {
    const { code, message } = await exitMessage(failure);

    expect(code).toBe(1);
    expect(message).toContain(expected);
  });

  it('reports the HTTP status once, like the Python path', async () => {
    const { message } = await exitMessage(new AuthenticationError(401, { message: 'invalid token' }, 'invalid token', new Headers()));

    expect(message).toContain('Agent Engine returned HTTP 401: invalid token');
  });

  it('an unreachable Agent Engine exits with a readable message', async () => {
    const { code, message } = await exitMessage(new APIConnectionError({ message: 'Connection error.' }));

    expect(code).toBe(1);
    expect(message).toContain('ORCA_BASE_URL');
  });
});
