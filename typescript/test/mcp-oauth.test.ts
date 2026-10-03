/** OAuth delegation, reuse and doctor without a live browser or credentials. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import Orca, { type VaultCredential } from '@runorca/orca-sdk';
import { Config, ConfigError, State, authorizeMcp, ensureVault } from '../src/common.js';
import { probeMcp } from '../src/doctor.js';
import { fakeClient } from './fakes.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const URL = 'https://mcp.example.com/mcp';
const config = (values: Record<string, string> = {}) => new Config({ ORCA_BASE_URL: 'https://registry.example.com', SN_API_KEY: 'registry-secret', SN_MCP_URL: URL, ...values }, 'jane');
let state: State;
beforeEach(() => {
  vi.clearAllMocks();
  state = new State(join(mkdtempSync(join(tmpdir(), 'hello-oauth-')), 'jane.json'));
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
});

async function seed(client: ReturnType<typeof fakeClient>, authType: 'mcp_oauth' | 'static_bearer' = 'mcp_oauth', url = URL, archived = false) {
  const vault = await client.vaults.create({ display_name: 'test' });
  state.set('vault_id', vault.id);
  const credential: VaultCredential = { id: 'cred_oauth', vault_id: vault.id, type: 'vault_credential', display_name: 'test', metadata: {}, created_at: 'now', updated_at: 'now', archived_at: archived ? 'old' : null, auth: { type: authType, mcp_server_url: url } };
  client.vaults.credentials.store.set(vault.id, [credential]);
  return vault.id;
}

it.each([false, true])('delegates OAuth without secret arguments; local=%s', (local) => {
  process.env.ORCA_API_KEY = 'stale-local';
  process.env.ORCA_ACCESS_TOKEN = 'stale-bearer';
  try {
    authorizeMcp('vlt_1', config({ SN_MCP_OAUTH_ISSUER: 'https://auth.example.com/', SN_MCP_OAUTH_SCOPE: 'openid offline_access', ...(local ? { ORCA_API_KEY: 'local-secret' } : {}) }));
    const [command, args, opts] = vi.mocked(spawnSync).mock.calls[0];
    expect(command).toBe('ork');
    expect(args).toEqual(['agent', 'vaults', 'credentials', 'create', '--vault', 'vlt_1', '--display-name', 'streamnative-mcp', '--mcp-server-url', URL, '-o', 'json', '--oauth-issuer', 'https://auth.example.com/', '--oauth-scope', 'openid offline_access']);
    const options = opts as { env: NodeJS.ProcessEnv; stdio: string };
    expect(options.stdio).toBe('inherit');
    expect(options.env.ORCA_REGISTRY_URL).toBe('https://registry.example.com');
    expect(options.env.ORCA_API_KEY).toBe(local ? 'local-secret' : undefined);
    expect(options.env.ORCA_ACCESS_TOKEN).toBe(local ? undefined : 'registry-secret');
    expect(JSON.stringify(args)).not.toContain('secret');
  } finally {
    delete process.env.ORCA_API_KEY;
    delete process.env.ORCA_ACCESS_TOKEN;
  }
});

it('creates an OAuth vault by default and reuses its credential across runs', async () => {
  const client = fakeClient();
  const vaultId = await ensureVault(client, state, 'test', config());
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(client.vaults.credentials.calls.filter((c) => c[0] === 'create')).toEqual([]);
  expect(readFileSync(state.path, 'utf8')).not.toContain('registry-secret');
  // The CLI, not the SDK, populated this read shape on the server.
  client.vaults.credentials.store.set(vaultId, [{ id: 'cred_oauth', type: 'vault_credential', vault_id: vaultId, display_name: 'test', metadata: {}, created_at: 'now', updated_at: 'now', archived_at: null, auth: { type: 'mcp_oauth', mcp_server_url: URL } }]);
  expect(await ensureVault(client, state, 'test', config())).toBe(vaultId);
  expect(spawnSync).toHaveBeenCalledTimes(1);
});

it.each([
  ['static_bearer', URL, false],
  ['mcp_oauth', URL + '-other', false],
  ['mcp_oauth', URL, true],
] as const)('does not reuse %s at %s archived=%s', async (authType, url, archived) => {
  const client = fakeClient();
  await seed(client, authType, url, archived);
  await ensureVault(client, state, 'test', config());
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(client.vaults.credentials.calls.filter((c) => c[0] === 'archive')).toHaveLength(authType === 'static_bearer' && url === URL && !archived ? 1 : 0);
});

it.each([{ status: 1 }, { status: null, error: new Error('missing ork') }])('stops OAuth errors without a static fallback', async (result) => {
  vi.mocked(spawnSync).mockReturnValue(result as ReturnType<typeof spawnSync>);
  const client = fakeClient();
  await expect(ensureVault(client, state, 'test', config())).rejects.toBeInstanceOf(ConfigError);
  expect(client.vaults.credentials.calls.filter((c) => c[0] === 'create')).toEqual([]);
});

it('rejects an invalid auth mode before creating resources', async () => {
  const client = fakeClient();
  await expect(ensureVault(client, state, 'test', config({ SN_MCP_AUTH: 'typo' }))).rejects.toThrow('SN_MCP_AUTH');
  expect(client.vaults.calls).toEqual([]);
});

it.each([['valid', true], ['invalid', false], ['unknown', false]] as const)('doctor uses server-side validation: %s', async (status, ok) => {
  const fake = fakeClient();
  const vaultId = await seed(fake);
  const client = new Orca({ baseURL: 'https://registry.example.com', apiKey: 'test' });
  vi.spyOn(client.vaults.credentials, 'list').mockImplementation(() => fake.vaults.credentials.list(vaultId) as ReturnType<typeof client.vaults.credentials.list>);
  const validate = vi.spyOn(client.vaults.credentials, 'validate').mockResolvedValue({ status } as Awaited<ReturnType<typeof client.vaults.credentials.validate>>);
  const check = await probeMcp(config(), client, state);
  expect(check.ok).toBe(ok);
  expect(check.label).toBe(ok ? 'PASS' : 'FAIL');
  expect(check.detail).toContain('initialization');
  if (status === 'unknown') expect(check.fix).toContain('keep the existing credential');
  if (status === 'invalid') {
    expect(check.fix).toContain('credentials archive cred_oauth');
    expect(check.fix).toContain('Lab 3');
  }
  expectLabsNamedLikeTheCourse(`${check.detail} ${check.fix}`);
  expect(validate).toHaveBeenCalledWith(vaultId, 'cred_oauth');
});

/** The course says "Lab 3", so the scripts do too: never "L3" or "L4". */
function expectLabsNamedLikeTheCourse(text: string): void {
  expect(text).not.toMatch(/\bL[0-9]\b/);
}

it('doctor names the lab when the MCP server cannot be checked', async () => {
  const fake = fakeClient();
  await seed(fake);
  const client = new Orca({ baseURL: 'https://registry.example.com', apiKey: 'test' });
  vi.spyOn(client.vaults.credentials, 'list').mockRejectedValue(new Error('HTTP 502'));

  const check = await probeMcp(config(), client, state);

  expect(check.label).toBe('FAIL');
  expect(check.detail).toContain('HTTP 502');
  expect(check.fix).toContain('Lab 3');
  expectLabsNamedLikeTheCourse(`${check.detail} ${check.fix}`);
});

it('a failed OAuth login names the lab to run again', () => {
  vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);

  let message = '';
  try {
    authorizeMcp('vlt_1', config());
  } catch (err) {
    message = (err as Error).message;
  }

  expect(message).toContain('Lab 3');
  expectLabsNamedLikeTheCourse(message);
});

it('doctor before the first OAuth login waits for Lab 3', async () => {
  const client = new Orca({ baseURL: 'https://registry.example.com', apiKey: 'test' });
  const check = await probeMcp(config(), client, state);
  expect(check.wait).toBe(true);
  expect(check.label).toBe('WAIT');
  expect(check.fix).toContain('Lab 3');
});

it('doctor waits when the vault has no OAuth credential yet', async () => {
  const fake = fakeClient();
  const vaultId = await seed(fake, 'static_bearer');
  const client = new Orca({ baseURL: 'https://registry.example.com', apiKey: 'test' });
  vi.spyOn(client.vaults.credentials, 'list').mockImplementation(() => fake.vaults.credentials.list(vaultId) as ReturnType<typeof client.vaults.credentials.list>);
  const check = await probeMcp(config(), client, state);
  expect(check.wait).toBe(true);
  expect(check.fix).toContain('Lab 3');
});
