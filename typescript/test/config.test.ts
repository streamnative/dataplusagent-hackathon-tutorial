/** loadConfig: read the team card (.env) and fail with every problem at once. */

import os from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigError, loadConfig, orcaClient } from '../src/common.js';

const CARD = {
  ORCA_BASE_URL: 'https://ws.example.com',
  SN_API_KEY: 'key',
  ORCA_MODEL: 'claude-sonnet-4-6',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('loadConfig', () => {
  it('names every missing variable in one error', () => {
    let error: unknown;
    try {
      loadConfig(['ORCA_BASE_URL', 'SN_API_KEY', 'ORCA_MODEL'], { ORCA_MODEL: 'm' });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain('ORCA_BASE_URL');
    expect(message).toContain('SN_API_KEY');
    expect(message).not.toContain('ORCA_MODEL');
  });

  it('counts a blank value as missing', () => {
    expect(() => loadConfig(['SN_API_KEY'], { SN_API_KEY: '   ' })).toThrow(/SN_API_KEY/);
  });

  it('makes values available by name', () => {
    const config = loadConfig(['ORCA_BASE_URL'], CARD);

    expect(config.get('ORCA_BASE_URL')).toBe('https://ws.example.com');
  });

  it.each([
    ['Jane.Doe_42', 'jane-doe-42'],
    ['  Team 7 / Ana  ', 'team-7-ana'],
    ['ÅSA', 'sa'],
    ['...', 'participant'],
  ])('turns participant %j into the safe resource name %j', (raw, expected) => {
    expect(loadConfig([], { PARTICIPANT: raw }).participant).toBe(expected);
  });

  it('defaults the participant to the OS user', () => {
    vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'Sam.Lee', uid: 1, gid: 1, shell: null, homedir: '/home/sam' });

    expect(loadConfig([], {}).participant).toBe('sam-lee');
  });

  it('never prints the API key', () => {
    const config = loadConfig([], { ...CARD, PARTICIPANT: 'jane' });

    expect(JSON.stringify(config)).not.toContain('key');
    expect(String(config)).not.toContain('key');
  });
});


describe('Registry authentication', () => {
  it.each([
    [{ SN_API_KEY: 'team-key' }, 'Bearer team-key', null],
    [{ ORCA_API_KEY: 'local-key' }, null, 'local-key'],
    [{ ORCA_API_KEY: 'local-key', SN_API_KEY: 'mcp-key' }, null, 'local-key'],
  ])('sends exactly one Registry credential', async (credentials, bearer, workspaceKey) => {
    vi.stubEnv('ORCA_API_KEY', 'ambient-key-must-not-be-used-as-bearer');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [], next_page: null }), { headers: { 'Content-Type': 'application/json' } }),
    );
    const config = loadConfig([], { ORCA_BASE_URL: 'http://127.0.0.1:8080', ...credentials });
    await orcaClient(config).agents.list({ limit: 1 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get('Authorization')).toBe(bearer);
    expect(headers.get('x-api-key')).toBe(workspaceKey);
  });

  it('explains how to supply a missing Registry credential', () => {
    expect(() => orcaClient(loadConfig([], { ORCA_BASE_URL: 'http://127.0.0.1:8080' }))).toThrow(/ORCA_API_KEY.*SN_API_KEY/);
  });
});
