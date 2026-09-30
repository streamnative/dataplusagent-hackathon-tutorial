/**
 * Check your laptop and your team card before the tutorial starts.
 *
 *     npm run doctor                 # laptop + .env + Agent Engine + Kafka + Schema Registry + MCP
 *     npm run doctor -- --offline    # laptop only (run this before the event)
 *     npm run doctor -- --agent-only # laptop + Agent Engine (for ork local / L1)
 *
 * Every failed check prints the fix.
 */

import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Config } from './common.js';

const TS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CARD = ['SN_API_KEY', 'SN_SERVICE_ACCOUNT', 'ORCA_BASE_URL', 'KAFKA_BOOTSTRAP_SERVERS', 'SCHEMA_REGISTRY_URL', 'SN_MCP_URL', 'LOGIN_TOPIC', 'ORCA_MODEL'];
const SQL_FIELDS = ['account_id', 'event_time', 'ip_address', 'result', 'failure_reason'];
const MCP_TOOLS = ['sql_workspace_list_databases', 'sql_workspace_query', 'sql_workspace_insert_rows'];
const PACKAGES = ['@runorca/orca-sdk', 'kafkajs', '@kafkajs/confluent-schema-registry', 'dotenv'];

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
}

function check(name: string, ok: boolean, detail = '', fix = ''): Check {
  return { name, ok, detail, fix };
}

// ------------------------------------------------------------- decisions --

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

export function checkLoginSchema(fields: string[]): Check {
  const present = new Set(fields);
  const missing = SQL_FIELDS.filter((name) => !present.has(name));
  if (missing.length === 0) return check('login topic schema', true, `has ${SQL_FIELDS.join(', ')}`);
  let fix = 'The SQL in sql/ expects these fields: ask a facilitator which schema your topic uses.';
  if (missing.includes('result') && present.has('outcome')) {
    fix = 'Your topic names the login result `outcome`, not `result`: use `outcome` in sql/01 and sql/02 (and check its values).';
  }
  return check('login topic schema', false, `missing ${missing.join(', ')}`, fix);
}

export function checkMcpTools(names: string[]): Check {
  const offered = new Set(names);
  const missing = MCP_TOOLS.filter((tool) => !offered.has(tool));
  if (missing.length === 0) return check('MCP tools', true, MCP_TOOLS.join(', '));
  return check('MCP tools', false, `missing ${missing.join(', ')}`, 'The MCP server does not offer these tools to your key: ask a facilitator.');
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

export function kafkaHint(error: string): string {
  const text = error.toLowerCase();
  if (text.includes('authentication') || text.includes('sasl')) {
    return (
      'Kafka rejected the login. SN_SERVICE_ACCOUNT must be the full principal ' +
      "(<name>@<org>.auth.streamnative.cloud) and SN_API_KEY the raw key, with no 'token:' prefix."
    );
  }
  if (text.includes('authorization')) {
    return 'Your key logs in but may not use this topic: its rolebinding is missing. Ask a facilitator.';
  }
  if (['resolve', 'transport', 'timed out', 'connect'].some((word) => text.includes(word))) {
    return 'Cannot reach Kafka. Check KAFKA_BOOTSTRAP_SERVERS (host:port from your team card) and your network.';
  }
  return 'See the error above, or ask a facilitator.';
}

// ---------------------------------------------------------------- probes --

function checkPackages(agentOnly = false): Check[] {
  return PACKAGES.filter((pkg) => !agentOnly || ['@runorca/orca-sdk', 'dotenv'].includes(pkg)).map((pkg) => {
    const found = existsSync(join(TS_ROOT, 'node_modules', pkg, 'package.json'));
    return check(`package ${pkg}`, found, '', found ? '' : 'Run: npm install');
  });
}

/** Only the CLI path needs these, so a missing tool is reported but never fails. */
function checkCliTools(): Check[] {
  const onPath = (tool: string) =>
    (process.env.PATH ?? '')
      .split(delimiter)
      .some((dir) => dir && ['', '.exe', '.cmd'].some((ext) => existsSync(join(dir, tool + ext))));
  return ['ork', 'jq'].map((tool) =>
    check(`${tool} (CLI path only)`, true, onPath(tool) ? 'found' : 'not found: fine unless you take the CLI path'),
  );
}

async function probeOrca(config: Config): Promise<Check> {
  const { APIConnectionError, APIError } = await import('@runorca/orca-sdk');
  const { orcaClient } = await import('./common.js');
  try {
    await orcaClient(config).agents.list({ limit: 1 }, { timeout: 30_000 });
  } catch (err) {
    // A connection error is also an APIError, so check it first.
    if (err instanceof APIConnectionError) {
      return check('Agent Engine', false, err.message, 'Cannot reach ORCA_BASE_URL. Check the URL and your network.');
    }
    if (err instanceof APIError && err.status) {
      let fix = 'Ask a facilitator.';
      if (err.status === 401 || err.status === 403) {
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
  const topicName = config.get('LOGIN_TOPIC');
  const admin = new Kafka({
    clientId: 'hello-doctor',
    brokers: config
      .get('KAFKA_BOOTSTRAP_SERVERS')
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean),
    ssl: true,
    sasl: { mechanism: 'plain', username: config.get('SN_SERVICE_ACCOUNT'), password: config.get('SN_API_KEY') },
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
    if (!topic) return check('Kafka', false, `${topicName}: not found`, kafkaHint('not found'));
    return check('Kafka', true, `${topicName} has ${topic.partitions.length} partition(s)`);
  } catch (err) {
    if ((err as { type?: string }).type === 'UNKNOWN_TOPIC_OR_PARTITION') {
      return check('Kafka', false, `${topicName}: not found`, kafkaHint('not found'));
    }
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return check('Kafka', false, reason, kafkaHint(reason));
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

async function probeSchemaRegistry(config: Config): Promise<Check[]> {
  const subject = `${config.get('LOGIN_TOPIC')}-value`;
  const base = config.get('SCHEMA_REGISTRY_URL').replace(/\/+$/, '');
  const credentials = Buffer.from(`${config.get('SN_SERVICE_ACCOUNT')}:${config.get('SN_API_KEY')}`).toString('base64');
  try {
    const response = await fetch(`${base}/subjects/${encodeURIComponent(subject)}/versions/latest`, {
      headers: { Authorization: `Basic ${credentials}`, Accept: 'application/vnd.schemaregistry.v1+json, application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const latest = (await response.json()) as { version: number; schema: string };
    const fields = (JSON.parse(latest.schema).fields as Array<{ name: string }>).map((field) => field.name);
    return [check('Schema Registry', true, `${subject} v${latest.version}`), checkLoginSchema(fields)];
  } catch (err) {
    return [check('Schema Registry', false, errorText(err), 'Check SCHEMA_REGISTRY_URL; your key may lack Schema Registry read access.')];
  }
}

/** Ask the MCP server which tools it offers: initialize, then tools/list. */
async function mcpToolNames(url: string, token: string): Promise<string[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  async function post(payload: Record<string, unknown>): Promise<Record<string, any> | null> {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? 'application/json';
    return 'id' in payload ? parseMcpResponse(contentType, body, payload.id as number) : null;
  }

  const hello = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hello-doctor', version: '1' } };
  const init = (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: hello })) ?? {};
  headers['MCP-Protocol-Version'] = init.protocolVersion ?? hello.protocolVersion;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const names: string[] = [];
  let cursor: string | undefined;
  for (let requestId = 2; requestId < 12; requestId += 1) {
    const params = cursor ? { cursor } : {};
    const page = (await post({ jsonrpc: '2.0', id: requestId, method: 'tools/list', params })) ?? {};
    names.push(...((page.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return names;
}

async function probeMcp(config: Config): Promise<Check> {
  let names: string[];
  try {
    names = await mcpToolNames(config.get('SN_MCP_URL'), config.get('SN_API_KEY'));
  } catch (err) {
    return check('MCP server', false, errorText(err), 'Check SN_MCP_URL, and that MCP is enabled for your key: ask a facilitator.');
  }
  return checkMcpTools(names);
}

// ------------------------------------------------------------------ main --

export async function runChecks(offline: boolean, agentOnly = false): Promise<Check[]> {
  const checks = [checkNode(process.versions.node), ...checkPackages(agentOnly), ...checkCliTools()];
  if (offline || !checks.every((c) => c.ok)) return checks;

  const { loadConfig } = await import('./common.js');
  const config = loadConfig([]);
  const required = agentOnly ? ['ORCA_BASE_URL', 'ORCA_MODEL'] : CARD;
  const missing = required.filter((name) => !config.has(name));
  if (agentOnly && !config.has('ORCA_API_KEY') && !config.has('SN_API_KEY')) missing.push('ORCA_API_KEY or SN_API_KEY');
  if (missing.length > 0) {
    const fix = 'Copy .env.example to .env in the repo root and paste your team card.';
    return [...checks, check('team card (.env)', false, `missing ${missing.join(', ')}`, fix)];
  }

  checks.push(check('team card (.env)', true, `participant: ${config.participant}`));
  const baseUrl = checkOrcaBaseUrl(config.get('ORCA_BASE_URL'));
  checks.push(baseUrl);
  if (baseUrl.ok) checks.push(await probeOrca(config));
  if (agentOnly) return checks;
  checks.push(await probeKafka(config));
  checks.push(...(await probeSchemaRegistry(config)));
  checks.push(await probeMcp(config));
  return checks;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const checks = await runChecks(args.includes('--offline'), args.includes('--agent-only'));
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(32)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`      fix: ${c.fix}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed === 0 ? "\nAll good: you're ready." : `\n${failed} check(s) failed. Fix them, then run doctor again.`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
