/**
 * Check your laptop and your .env before a lab.
 *
 *     npm run doctor                 # laptop + .env + Agent Engine + Kafka + Schema Registry + MCP
 *     npm run doctor -- --offline    # laptop only (run this before the event)
 *     npm run doctor -- --agent-only # laptop + Agent Engine (enough for Lab 1)
 *
 * It checks the stack your .env is for: your team card on StreamNative Cloud, or
 * the stack on your laptop. Every failed check prints the fix.
 */

import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type Orca from '@runorca/orca-sdk';
import type { Config, Stack, State } from './common.js';

const TS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CARD = ['SN_API_KEY', 'SN_SERVICE_ACCOUNT', 'ORCA_BASE_URL', 'KAFKA_BOOTSTRAP_SERVERS', 'SCHEMA_REGISTRY_URL', 'SN_MCP_URL', 'LOGIN_TOPIC', 'ORCA_MODEL'];
const LOCAL = ['ORCA_API_KEY', 'ORCA_BASE_URL', 'KAFKA_BOOTSTRAP_SERVERS', 'SCHEMA_REGISTRY_URL', 'RW_MCP_URL', 'RW_MCP_LOCAL_URL', 'LOGIN_TOPIC', 'ORCA_MODEL'];
const SQL_FIELDS = ['account_id', 'event_time', 'ip_address', 'result', 'failure_reason'];
// The tools the agent definitions in agent/<stack>/ enable.
const MCP_TOOLS: Record<Stack, string[]> = {
  cloud: ['sql_workspace_list_databases', 'sql_workspace_query', 'sql_workspace_describe_table', 'sql_workspace_insert_rows'],
  local: ['run_select_query', 'describe_table', 'insert_multiple_rows'],
};
const PACKAGES = ['@runorca/orca-sdk', 'kafkajs', '@kafkajs/confluent-schema-registry', 'dotenv'];
const START_LOCAL_STACK = 'Start the streaming stack: docker compose -f local/compose.yaml up -d --wait';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
  wait: boolean; // not ready yet, and not your mistake: a later lab does it
  label: 'PASS' | 'WAIT' | 'FAIL';
}

export function check(name: string, ok: boolean, detail = '', fix = '', { wait = false } = {}): Check {
  return { name, ok, detail, fix, wait, label: ok ? 'PASS' : wait ? 'WAIT' : 'FAIL' };
}

// ------------------------------------------------------------- decisions --

export function requiredFor(stack: Stack): string[] {
  return stack === 'local' ? LOCAL : CARD;
}

export function checkNode(version: string): Check {
  const [major, minor] = version.split('.').map(Number);
  const ok = major >= 20;
  return check('Node 20+', ok, `${major}.${minor}`, ok ? '' : 'Install Node 20 or newer.');
}

export function checkOrcaBaseUrl(url: string): Check {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url.trim());
  } catch {
    // not a URL at all
  }
  const localHttp = parsed?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!parsed || !parsed.host || (parsed.protocol !== 'https:' && !localHttp)) {
    return check('ORCA_BASE_URL', false, url, 'Use the https:// registry endpoint from your team card, or http://127.0.0.1:8080 for ork local.');
  }
  const root = `${parsed.protocol}//${parsed.host}`;
  if (parsed.pathname.replace(/\/+$/, '')) {
    return check('ORCA_BASE_URL', false, url, `Use the host root only: ORCA_BASE_URL=${root}`);
  }
  return check('ORCA_BASE_URL', true, root);
}

export function checkLoginSchema(fields: string[], stack: Stack = 'cloud'): Check {
  const present = new Set(fields);
  const missing = SQL_FIELDS.filter((name) => !present.has(name));
  if (missing.length === 0) return check('login topic schema', true, `has ${SQL_FIELDS.join(', ')}`);
  let fix = 'The SQL in sql/ expects these fields: ask a facilitator which schema your topic uses.';
  if (missing.includes('result') && present.has('outcome')) {
    fix = `Your topic names the login result \`outcome\`, not \`result\`: use \`outcome\` in sql/${stack}/01_explore.sql and sql/${stack}/02_login_failures.sql (and check its values).`;
  }
  return check('login topic schema', false, `missing ${missing.join(', ')}`, fix);
}

export function checkMcpTools(names: string[], stack: Stack = 'cloud'): Check {
  const wanted = MCP_TOOLS[stack];
  const offered = new Set(names);
  const missing = wanted.filter((tool) => !offered.has(tool));
  if (missing.length === 0) return check('MCP tools', true, wanted.join(', '));
  const fix =
    stack === 'local'
      ? 'The agent definitions in agent/local/ need these tools: check the risingwave-mcp image tag in local/compose.yaml.'
      : 'The MCP server does not offer these tools to your key: ask a facilitator.';
  return check('MCP tools', false, `missing ${missing.join(', ')}`, fix);
}

/** `SELECT 1` through the MCP server: one row back means it reaches RisingWave. */
export function checkMcpQuery(text: string): Check {
  let rows: unknown = null;
  try {
    rows = JSON.parse(text);
  } catch {
    // not JSON: an error message
  }
  if (Array.isArray(rows) && rows.length === 1) return check('RisingWave through MCP', true, 'SELECT 1 returned a row');
  return check('RisingWave through MCP', false, text.slice(0, 200), `The MCP server cannot query RisingWave. ${START_LOCAL_STACK}`);
}

/** Pick the JSON-RPC reply to `requestId` out of a JSON or event-stream body. */
export function parseMcpResponse(contentType: string, body: string, requestId: number): Record<string, any> {
  const messages = contentType.startsWith('text/event-stream')
    ? body
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice('data:'.length)))
    : [JSON.parse(body)];
  for (const message of messages) {
    if (message.id === requestId) {
      if (message.error) throw new Error(message.error.message ?? 'MCP error');
      return message.result ?? {};
    }
  }
  throw new Error(`no reply to MCP request ${requestId}`);
}

/** An error's message, plus its cause when there is one (fetch hides the real reason there). */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : '';
  return cause ? `${err.message}: ${cause}` : err.message;
}

export function kafkaHint(error: string, stack: Stack = 'cloud'): string {
  const text = error.toLowerCase();
  const unreachable = ['resolve', 'transport', 'timed out', 'connect'].some((word) => text.includes(word));
  if (stack === 'local') {
    if (unreachable) return `Cannot reach Kafka on your laptop. ${START_LOCAL_STACK}`;
    return 'The login topic is not there yet. Create it and seed it: Local course, Lab 0.';
  }
  if (text.includes('authentication') || text.includes('sasl')) {
    return (
      'Kafka rejected the login. SN_SERVICE_ACCOUNT must be the full principal ' +
      "(<name>@<org>.auth.streamnative.cloud) and SN_API_KEY the raw key, with no 'token:' prefix."
    );
  }
  if (text.includes('authorization')) {
    return 'Your key logs in but may not use this topic: its rolebinding is missing. Ask a facilitator.';
  }
  if (unreachable) {
    return 'Cannot reach Kafka. Check KAFKA_BOOTSTRAP_SERVERS (host:port from your team card) and your network.';
  }
  return 'See the error above, or ask a facilitator.';
}

export function schemaRegistryHint(error: string, stack: Stack = 'cloud'): string {
  if (stack !== 'local') return 'Check SCHEMA_REGISTRY_URL; your key may lack Schema Registry read access.';
  if (error.toLowerCase().includes('not found')) return 'The schema is registered when you seed the topic: npm run seed (Local course, Lab 0).';
  return `Cannot reach Schema Registry on your laptop. ${START_LOCAL_STACK}`;
}

export function mcpHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** The exit code and the last line. A waiting check is not a failure. */
export function summarize(checks: Check[]): { code: number; verdict: string } {
  const failed = checks.filter((c) => c.label === 'FAIL').length;
  const waiting = checks.filter((c) => c.label === 'WAIT').length;
  if (failed > 0) return { code: 1, verdict: `${failed} check(s) failed. Fix them, then run doctor again.` };
  if (waiting > 0) return { code: 0, verdict: `You're ready. ${waiting} check(s) wait for a later lab.` };
  return { code: 0, verdict: "All good: you're ready." };
}

// ---------------------------------------------------------------- probes --

function checkPackages(agentOnly = false): Check[] {
  return PACKAGES.filter((pkg) => !agentOnly || ['@runorca/orca-sdk', 'dotenv'].includes(pkg)).map((pkg) => {
    const found = existsSync(join(TS_ROOT, 'node_modules', pkg, 'package.json'));
    return check(`package ${pkg}`, found, '', found ? '' : 'Run: npm install');
  });
}

function onPath(tool: string): boolean {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && ['', '.exe', '.cmd'].some((ext) => existsSync(join(dir, tool + ext))));
}

/** ork and jq run the checks in each lab; ork also does the first OAuth login. Reported, never failed. */
function checkCliTools(): Check[] {
  const notes: Record<string, string> = {
    ork: 'not found: install it for the lab checks and the first OAuth MCP login',
    jq: 'not found: install it for the lab checks',
  };
  return ['ork', 'jq'].map((tool) => check(tool, true, onPath(tool) ? 'found' : notes[tool]));
}

function checkDocker(): Check {
  const found = onPath('docker');
  return check('docker', found, found ? 'found' : 'not found', found ? '' : 'The Local course runs in Docker: install Docker Desktop, or Docker Engine with Compose v2.');
}

async function probeOrca(config: Config): Promise<Check> {
  const { APIConnectionError, APIError } = await import('@runorca/orca-sdk');
  const { orcaClient } = await import('./common.js');
  const local = config.stack === 'local';
  try {
    await orcaClient(config).agents.list({ limit: 1 }, { timeout: 30_000 });
  } catch (err) {
    // A connection error is also an APIError, so check it first.
    if (err instanceof APIConnectionError) {
      const fix = local ? 'Start the Agent Engine: local/engine.sh' : 'Cannot reach ORCA_BASE_URL. Check the URL and your network.';
      return check('Agent Engine', false, err.message, fix);
    }
    if (err instanceof APIError && err.status) {
      let fix = 'Ask a facilitator.';
      if ((err.status === 401 || err.status === 403) && local) {
        fix = 'The key in .env does not match the running stack. Run local/write-env.sh; if it still fails, start over with local/down.sh --reset.';
      } else if (err.status === 401 || err.status === 403) {
        fix = 'The Agent Engine rejected the key. For ork local use its generated workspace key as ORCA_API_KEY; for a team card check SN_API_KEY and its rolebinding.';
      } else if (err.status === 404) {
        fix = 'ORCA_BASE_URL is not an Agent Engine registry: copy the registry endpoint from your team card.';
      }
      return check('Agent Engine', false, `HTTP ${err.status}`, fix);
    }
    throw err;
  }
  return check('Agent Engine', true, 'API key accepted');
}

async function probeKafka(config: Config): Promise<Check> {
  const { Kafka, logLevel } = await import('kafkajs');
  const { kafkaClientConfig } = await import('./common.js');
  const topicName = config.get('LOGIN_TOPIC');
  const admin = new Kafka({
    clientId: 'hello-doctor',
    ...kafkaClientConfig(config),
    logLevel: logLevel.NOTHING,
    connectionTimeout: 10_000,
    requestTimeout: 15_000,
    retry: { retries: 1 },
  }).admin();
  try {
    await admin.connect();
    // Listing existing topics avoids auto-creating a missing topic during preflight.
    const { topics } = await admin.fetchTopicMetadata();
    const topic = topics.find((t) => t.name === topicName);
    if (!topic) return check('Kafka', false, `${topicName}: not found`, kafkaHint('not found', config.stack));
    return check('Kafka', true, `${topicName} has ${topic.partitions.length} partition(s)`);
  } catch (err) {
    if ((err as { type?: string }).type === 'UNKNOWN_TOPIC_OR_PARTITION') {
      return check('Kafka', false, `${topicName}: not found`, kafkaHint('not found', config.stack));
    }
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return check('Kafka', false, reason, kafkaHint(reason, config.stack));
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

async function probeSchemaRegistry(config: Config): Promise<Check[]> {
  const { schemaRegistryConfig } = await import('./common.js');
  const subject = `${config.get('LOGIN_TOPIC')}-value`;
  const { host, auth } = schemaRegistryConfig(config);
  const headers: Record<string, string> = { Accept: 'application/vnd.schemaregistry.v1+json, application/json' };
  if (auth) headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  try {
    const response = await fetch(`${host.replace(/\/+$/, '')}/subjects/${encodeURIComponent(subject)}/versions/latest`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const latest = (await response.json()) as { version: number; schema: string };
    const fields = (JSON.parse(latest.schema).fields as Array<{ name: string }>).map((field) => field.name);
    return [check('Schema Registry', true, `${subject} v${latest.version}`), checkLoginSchema(fields, config.stack)];
  } catch (err) {
    return [check('Schema Registry', false, errorText(err), schemaRegistryHint(errorText(err), config.stack))];
  }
}

type McpRequest = (method: string, params: Record<string, unknown>) => Promise<Record<string, any>>;

/** Open an MCP session over HTTP. Returns `request(method, params)`. */
async function mcpConnect(url: string, token?: string): Promise<McpRequest> {
  const headers = mcpHeaders(token);
  let nextId = 1;

  async function post(payload: Record<string, unknown>): Promise<Record<string, any> | null> {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? 'application/json';
    return 'id' in payload ? parseMcpResponse(contentType, body, payload.id as number) : null;
  }

  const request: McpRequest = async (method, params) => (await post({ jsonrpc: '2.0', id: nextId++, method, params })) ?? {};

  const hello = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hello-doctor', version: '1' } };
  const init = await request('initialize', hello);
  headers['MCP-Protocol-Version'] = init.protocolVersion ?? hello.protocolVersion;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return request;
}

/** Ask the MCP server which tools it offers: tools/list, page by page. */
async function mcpToolNames(request: McpRequest): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await request('tools/list', cursor ? { cursor } : {});
    names.push(...((page.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return names;
}

export async function probeMcp(config: Config, client?: Pick<Orca, 'vaults'>, state?: State): Promise<Check> {
  const { mcpAuthType, orcaClient, stateFor } = await import('./common.js');
  let names: string[];
  try {
    if (mcpAuthType(config) === 'mcp_oauth') {
      client ??= orcaClient(config);
      state ??= stateFor(config);
      const vaultId = state.get('vault_id');
      const later = 'Nothing to do now: Lab 3 opens your browser to authorize the MCP server. Run doctor again after it.';
      if (!vaultId) return check('MCP OAuth', false, 'no tutorial vault yet', later, { wait: true });
      const { data } = await client.vaults.credentials.list(vaultId);
      const credential = data.find((c) => c.auth.type === 'mcp_oauth' && c.auth.mcp_server_url === config.get('SN_MCP_URL') && !c.archived_at);
      if (!credential) return check('MCP OAuth', false, 'no matching OAuth credential', later, { wait: true });
      const result = await client.vaults.credentials.validate(vaultId, credential.id);
      let fix = '';
      if (result.status === 'unknown') fix = 'The MCP probe was inconclusive. Check Registry/MCP connectivity and rerun doctor; keep the existing credential.';
      else if (result.status === 'invalid') fix = `Reauthorize: ork agent vaults credentials archive ${credential.id} --vault ${vaultId}, then run the Lab 3 script again.`;
      return check('MCP OAuth', result.status === 'valid', `${result.status}: MCP initialization; the SQL tools are checked in Labs 3 and 4`, fix);
    }
    names = await mcpToolNames(await mcpConnect(config.get('SN_MCP_URL'), config.get('SN_API_KEY')));
  } catch (err) {
    return check('MCP server', false, errorText(err), 'Check SN_MCP_URL and SN_MCP_AUTH; for OAuth, finish the Lab 3 browser login and verify the vault credential.');
  }
  return checkMcpTools(names);
}

/** The MCP server on your laptop, as your terminal reaches it. No credential. */
async function probeLocalMcp(config: Config): Promise<Check[]> {
  try {
    const request = await mcpConnect(config.get('RW_MCP_LOCAL_URL'));
    const tools = checkMcpTools(await mcpToolNames(request), 'local');
    const result = await request('tools/call', { name: 'run_select_query', arguments: { query: 'SELECT 1 AS ready' } });
    const text = ((result.content ?? []) as Array<{ text?: string }>).map((block) => block.text ?? '').join('');
    return [tools, checkMcpQuery(text)];
  } catch (err) {
    return [check('MCP server', false, errorText(err), START_LOCAL_STACK)];
  }
}

// ------------------------------------------------------------------ main --

export async function runChecks(offline: boolean, agentOnly = false): Promise<Check[]> {
  const checks = [checkNode(process.versions.node), ...checkPackages(agentOnly), ...checkCliTools()];
  if (offline || !checks.every((c) => c.ok)) return checks;

  const { ConfigError, loadConfig, setupHint } = await import('./common.js');
  const config = loadConfig([]);
  let stack: Stack;
  try {
    stack = config.stack;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return [...checks, check('.env', false, err.message, 'Set TUTORIAL_STACK=cloud or TUTORIAL_STACK=local in .env, or remove the line.')];
  }
  const required = agentOnly ? ['ORCA_BASE_URL', 'ORCA_MODEL'] : requiredFor(stack);
  const missing = required.filter((name) => !config.has(name));
  if (agentOnly && !config.has('ORCA_API_KEY') && !config.has('SN_API_KEY')) missing.push('ORCA_API_KEY or SN_API_KEY');
  if (missing.length > 0) return [...checks, check('.env', false, `missing ${missing.join(', ')}`, setupHint(config))];

  checks.push(check('.env', true, `${stack} stack, participant: ${config.participant}`));
  if (stack === 'local') checks.push(checkDocker());
  const baseUrl = checkOrcaBaseUrl(config.get('ORCA_BASE_URL'));
  checks.push(baseUrl);
  if (baseUrl.ok) checks.push(await probeOrca(config));
  if (agentOnly) return checks;
  checks.push(await probeKafka(config));
  checks.push(...(await probeSchemaRegistry(config)));
  if (stack === 'local') checks.push(...(await probeLocalMcp(config)));
  else checks.push(await probeMcp(config));
  return checks;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const checks = await runChecks(args.includes('--offline'), args.includes('--agent-only'));
  for (const c of checks) {
    console.log(`${c.label}  ${c.name.padEnd(32)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`      ${c.wait ? 'next' : 'fix'}: ${c.fix}`);
  }
  const { code, verdict } = summarize(checks);
  console.log(`\n${verdict}`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
