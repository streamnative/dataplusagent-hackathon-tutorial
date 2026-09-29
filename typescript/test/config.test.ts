/** loadConfig: read the team card (.env) and fail with every problem at once. */

import os from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigError, loadConfig } from '../src/common.js';

const CARD = {
  ORCA_BASE_URL: 'https://ws.example.com',
  SN_API_KEY: 'key',
  ORCA_MODEL: 'claude-sonnet-4-6',
};

afterEach(() => {
  vi.restoreAllMocks();
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
