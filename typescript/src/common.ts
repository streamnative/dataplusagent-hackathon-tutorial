/**
 * Shared helpers for the TypeScript path of the tutorial.
 *
 * The layer scripts (l1-hello.ts, l3-live-context.ts, l4-act.ts) stay short by
 * leaning on these helpers. Read those first; come here when you want the details.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import Orca, { APIConnectionError, APIError, ConflictError, NotFoundError } from '@runorca/orca-sdk';
import type {
  Agent,
  AgentCreateParams,
  AgentMcpServerInput,
  AgentToolDefinition,
  AgentUpdateParams,
  CredentialCreateParams,
  Environment,
  EnvironmentCreateParams,
  EventSendParams,
  EventSendResponse,
  Session,
  SessionCreateParams,
  SessionEvent,
  Vault,
  VaultCreateParams,
  VaultCredential,
} from '@runorca/orca-sdk';
import { parse as parseDotenv } from 'dotenv';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ------------------------------------------------------------------ config --

/** The team card (.env) is missing something. */
export class ConfigError extends Error {}

export class Config {
  readonly #values: Record<string, string>; // holds your API key: never print it

  constructor(
    values: Record<string, string>,
    readonly participant: string,
  ) {
    this.#values = values;
  }

  has(name: string): boolean {
    return name in this.#values;
  }

  get(name: string): string {
    if (!this.has(name)) throw new ConfigError(missingMessage([name]));
    return this.#values[name];
  }
}

/** Read the team card: the repo's .env file, overridden by exported variables. */
export function loadConfig(required: string[], env?: Record<string, string | undefined>): Config {
  const source = env ?? { ...readDotenv(join(REPO_ROOT, '.env')), ...process.env };
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value && value.trim()) values[name] = value.trim();
  }
  const missing = required.filter((name) => !(name in values));
  if (missing.length > 0) throw new ConfigError(missingMessage(missing));
  return new Config(values, slug(values.PARTICIPANT || osUser()));
}

function missingMessage(names: string[]): string {
  return `Missing ${names.join(', ')}. Copy .env.example to .env in the repo root and fill it in from your team card.`;
}

function readDotenv(path: string): Record<string, string> {
  return existsSync(path) ? parseDotenv(readFileSync(path)) : {};
}

function osUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/** Lowercase letters, digits, and dashes: safe in every resource name. */
function slug(raw: string): string {
  const trimmed = (text: string) => text.replace(/^-+|-+$/g, '');
  return trimmed(trimmed(raw.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 32)) || 'participant';
}

// ------------------------------------------------------------------- state --

/** Remembers the ids your scripts created, in .orca-state/<participant>.json. */
export class State {
  readonly #data: Record<string, string>;

  constructor(readonly path: string) {
    this.#data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  }

  get(key: string): string | null {
    return this.#data[key] ?? null;
  }

  set(key: string, value: string): void {
    this.#data[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.#data, null, 2)}\n`);
  }
}

export function stateFor(config: Config): State {
  return new State(join(REPO_ROOT, '.orca-state', `${config.participant}.json`));
}

// ------------------------------------------------------- agent definitions --

export interface Layer {
  layer: string;
  summary: string;
  system: string;
  mcp_servers: AgentMcpServerInput[];
  tools: AgentToolDefinition[];
}

export type AgentParams = AgentCreateParams & {
  name: string;
  model: string;
  system: string;
  mcp_servers: AgentMcpServerInput[];
  tools: AgentToolDefinition[];
  metadata: { tutorial: string; layer: string; definition_sha: string };
};

const PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/** Read agent/<name>.json: the same file the CLI and Python paths use. */
export function loadLayer(name: string): Layer {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'agent', `${name}.json`), 'utf8'));
}

/** The arguments for agents.create/update: the layer's JSON plus your name and model. */
export function agentParams(layer: Layer, config: Config): AgentParams {
  const params = {
    name: `hello-agent-${config.participant}`,
    model: config.get('ORCA_MODEL'),
    system: layer.system,
    // Always sent, even when empty: updates are partial, and an omitted
    // field would keep the previous layer's value.
    mcp_servers: fill(layer.mcp_servers, config),
    tools: fill(layer.tools, config),
  };
  // Same recipe in every language (and `jq -cS` in the CLI): compact JSON, sorted keys.
  const fingerprint = createHash('sha256').update(canonicalJson(params), 'utf8').digest('hex').slice(0, 16);
  return { ...params, metadata: { tutorial: 'dss2026-hello-world', layer: layer.layer, definition_sha: fingerprint } };
}

/** Replace ${NAME} placeholders with values from the team card. */
function fill<T>(value: T, config: Config): T {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (_match, name: string) => lookup(name, config)) as T;
  if (Array.isArray(value)) return value.map((item) => fill(item, config)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, config)])) as T;
  }
  return value;
}

function lookup(name: string, config: Config): string {
  if (!config.has(name)) throw new ConfigError(`Missing ${name}: the agent definition needs it. Add it to .env from your team card.`);
  return config.get(name);
}

/** JSON with no spaces and object keys sorted at every level. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

// ------------------------------------------------- Agent Engine resources --

/** What the tutorial uses from the Orca client: the real `Orca` fits, and so do the test fakes. */
export interface SessionEventsApi {
  stream(sessionId: string): Promise<AsyncIterable<SessionEvent>>;
  send(sessionId: string, params: EventSendParams): Promise<EventSendResponse>;
}

export interface Client {
  agents: {
    create(params: AgentCreateParams): Promise<Agent>;
    retrieve(agentId: string): Promise<Agent>;
    update(agentId: string, params: AgentUpdateParams): Promise<Agent>;
    archive(agentId: string): Promise<Agent>;
  };
  environments: {
    create(params: EnvironmentCreateParams): Promise<Environment>;
    retrieve(environmentId: string): Promise<Environment>;
    archive(environmentId: string): Promise<Environment>;
  };
  vaults: {
    create(params: VaultCreateParams): Promise<Vault>;
    retrieve(vaultId: string): Promise<Vault>;
    delete(vaultId: string): Promise<unknown>;
    credentials: {
      list(vaultId: string): Promise<{ data: VaultCredential[] }>;
      create(vaultId: string, params: CredentialCreateParams): Promise<VaultCredential>;
    };
  };
  sessions: {
    create(params: SessionCreateParams): Promise<Session>;
    events: SessionEventsApi;
  };
}

/** Use a Registry workspace key locally, or the team card's hosted Bearer key. */
export function orcaClient(config: Config): Orca {
  const baseURL = config.get('ORCA_BASE_URL');
  if (config.has('ORCA_API_KEY')) {
    return new Orca({ baseURL, apiKey: null, defaultHeaders: { 'x-api-key': config.get('ORCA_API_KEY') }, timeout: 600_000 });
  }
  if (config.has('SN_API_KEY')) return new Orca({ baseURL, apiKey: config.get('SN_API_KEY'), timeout: 600_000 });
  throw new ConfigError('Set ORCA_API_KEY for ork local, or SN_API_KEY from your team card.');
}

/** The sandbox your sessions run in. Created once, then reused. */
export async function ensureEnvironment(client: Pick<Client, 'environments'>, state: State, name: string): Promise<string> {
  let environment = await live((id) => client.environments.retrieve(id), state.get('environment_id'));
  if (!environment) {
    try {
      environment = await client.environments.create({ name });
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      // Names stay reserved after an environment is archived: pick a fresh one.
      environment = await client.environments.create({ name: `${name}-${randomBytes(2).toString('hex')}` });
    }
    state.set('environment_id', environment.id);
  }
  return environment.id;
}

/** Create your agent, or update it when the layer's definition changed. */
export async function ensureAgent(client: Pick<Client, 'agents'>, state: State, params: AgentParams): Promise<Agent> {
  let agent = await live((id) => client.agents.retrieve(id), state.get('agent_id'));
  if (!agent) {
    agent = await client.agents.create(params);
    state.set('agent_id', agent.id);
  } else if (agent.metadata?.definition_sha !== params.metadata.definition_sha) {
    // Every update is a new version. `version` guards against a concurrent edit.
    agent = await client.agents.update(agent.id, { version: agent.version, ...params });
  }
  return agent;
}

/**
 * A vault holding the credential the agent uses to call the MCP server.
 *
 * The token lives in the vault on the server side; it never enters a prompt.
 */
export async function ensureVault(
  client: Pick<Client, 'vaults'>,
  state: State,
  name: string,
  mcpUrl: string,
  token: string,
): Promise<string> {
  let vault = await live((id) => client.vaults.retrieve(id), state.get('vault_id'));
  if (!vault) {
    vault = await client.vaults.create({ display_name: name });
    state.set('vault_id', vault.id);
  }
  const { data: credentials } = await client.vaults.credentials.list(vault.id);
  const hasCredential = credentials.some((c) => 'mcp_server_url' in c.auth && c.auth.mcp_server_url === mcpUrl && !c.archived_at);
  if (!hasCredential) {
    await client.vaults.credentials.create(vault.id, {
      display_name: 'streamnative-mcp',
      auth: { type: 'static_bearer', mcp_server_url: mcpUrl, token },
    });
  }
  return vault.id;
}

/** The remembered resource, or null if it was never created, deleted, or archived. */
async function live<T extends { archived_at: string | null }>(
  retrieve: (id: string) => Promise<T>,
  resourceId: string | null,
): Promise<T | null> {
  if (!resourceId) return null;
  try {
    const resource = await retrieve(resourceId);
    return resource.archived_at ? null : resource;
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

// ------------------------------------------------------------- the scripts --

type Out = (line: string) => void;
type Ask = (prompt: string) => Promise<string>;
type ToolUse = Record<string, unknown>;
type Confirm = (toolUse: ToolUse) => boolean | Promise<boolean>;

/** Read one line from the terminal. Ctrl-C exits, as it does everywhere else. */
export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    rl.close();
    process.exit(130);
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Ask `first`, then whatever the participant types next, until they type nothing. */
export async function chat(
  client: { sessions: { events: SessionEventsApi } },
  sessionId: string,
  first: string,
  { confirm, ask = prompt, out = console.log }: { confirm?: Confirm; ask?: Ask; out?: Out } = {},
): Promise<void> {
  let question = first;
  while (question) {
    out(`[you]    ${question}`);
    await runTurn(client, sessionId, question, { confirm, out });
    question = (await ask('\nAsk again (Enter to quit): ')).trim();
  }
}

/** Show the tool call the agent wants to make, and let the human decide. */
export async function askHuman(toolUse: ToolUse, { ask = prompt, out = console.log }: { ask?: Ask; out?: Out } = {}): Promise<boolean> {
  out(`\n[approve?] The agent wants to run ${toolUse.name} with:`);
  out(JSON.stringify(toolUse.input ?? {}, null, 2));
  return ['y', 'yes'].includes((await ask('Allow it? [y/N] ')).trim().toLowerCase());
}

/** Archive the agent and environment, and delete the vault. Sessions reserve the environment. */
export async function cleanup(
  client: Pick<Client, 'agents' | 'environments' | 'vaults'>,
  state: State,
  { out = console.log }: { out?: Out } = {},
): Promise<void> {
  const steps: Array<[string, string, (id: string) => Promise<unknown>]> = [
    ['agent', 'agent_id', (id) => client.agents.archive(id)],
    ['vault', 'vault_id', (id) => client.vaults.delete(id)],
    ['environment', 'environment_id', (id) => client.environments.archive(id)],
  ];
  for (const [label, key, remove] of steps) {
    const resourceId = state.get(key);
    if (!resourceId) continue;
    try {
      await remove(resourceId);
      out(`removed ${label} ${resourceId}`);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      out(`${label} ${resourceId} was already gone`);
    }
  }
  rmSync(state.path, { force: true });
}

/** Run a script, turning known failures into a short explanation. */
export async function runMain(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (err) {
    console.error(`\n${explain(err)}`);
    process.exit(1);
  }
}

function explain(err: unknown): string {
  if (err instanceof ConfigError || err instanceof TurnError) return err.message;
  // A connection error is also an APIError, so check it first.
  if (err instanceof APIConnectionError) return 'Cannot reach the Agent Engine. Check ORCA_BASE_URL in .env, then run `npm run doctor`.';
  if (err instanceof APIError && err.status) {
    // The SDK prefixes its messages with the status; show it once.
    const message = err.message.replace(new RegExp(`^${err.status} `), '');
    return `Agent Engine returned HTTP ${err.status}: ${message}\nRun \`npm run doctor\` to check your setup.`;
  }
  throw err;
}

// ---------------------------------------------------------------- one turn --

/** The agent's turn could not complete. */
export class TurnError extends Error {}

export interface TurnResult {
  text: string;
}

export const DENY_MESSAGE = 'The human reviewer denied this action.';
const PREVIEW_CHARS = 160;

/**
 * Send one user message and follow the session until the agent's turn ends.
 *
 * `confirm(toolUse)` is asked whenever a tool with an `always_ask` policy wants
 * to run; return true to allow it, false to deny it.
 */
export async function runTurn(
  client: { sessions: { events: SessionEventsApi } },
  sessionId: string,
  text: string,
  { confirm, out = console.log }: { confirm?: Confirm; out?: Out } = {},
): Promise<TurnResult> {
  const events = client.sessions.events;
  // Listen first, then speak: an event emitted between the two would be lost.
  const stream = await events.stream(sessionId);
  const sent = await events.send(sessionId, { events: [{ type: 'user.message', content: [{ type: 'text', text }] }] });
  // Some servers replay the whole transcript on connect. Everything
  // processed before our message belongs to an earlier turn.
  const since = sent.data?.[0]?.processed_at ?? null;
  const seen = new Set<string>();
  const toolUses = new Map<string, ToolUse>();
  const replies: string[] = [];
  let lastError = '';

  for await (const event of stream as AsyncIterable<SessionEvent & Record<string, any>>) {
    if (seen.has(event.id) || before(event.processed_at, since)) continue;
    seen.add(event.id);

    if (event.type === 'agent.message') {
      const reply = (event.content ?? [])
        .filter((block: { type?: string }) => block.type === 'text')
        .map((block: { text?: string }) => block.text ?? '')
        .join('');
      replies.push(reply);
      out(`[agent]  ${reply}`);
    } else if (event.type === 'agent.mcp_tool_use') {
      toolUses.set(event.id, event);
      out(shorten(`[tool]   ${event.name} ${JSON.stringify(event.input ?? {})}`));
    } else if (event.type === 'agent.mcp_tool_result') {
      const label = event.is_error ? 'error' : 'result';
      out(shorten(`[${label}] ${contentText(event.content)}`));
    } else if (event.type === 'session.error') {
      lastError = event.error?.message || event.error?.type || 'unknown error';
      out(`[error]  ${lastError}${event.retry_status?.will_retry ? ' (retrying)' : ''}`);
    } else if (event.type === 'session.status_idle') {
      const stop = event.stop_reason ?? {};
      if (stop.type === 'requires_action') {
        await answerApprovals(events, sessionId, stop.event_ids ?? [], toolUses, confirm);
        continue;
      }
      if (stop.type === 'end_turn') return { text: replies.join('\n') };
      throw new TurnError(`The agent stopped (${stop.type}): ${lastError || 'no details'}`);
    }
  }
  throw new TurnError('The event stream ended before the agent finished its turn.');
}

async function answerApprovals(
  events: SessionEventsApi,
  sessionId: string,
  eventIds: string[],
  toolUses: Map<string, ToolUse>,
  confirm: Confirm | undefined,
): Promise<void> {
  if (!confirm) throw new TurnError('The agent is waiting for human approval, but this script has no approver.');
  const decisions = [];
  for (const toolUseId of eventIds) {
    const allowed = await confirm(toolUses.get(toolUseId) ?? { id: toolUseId });
    decisions.push({
      type: 'user.tool_confirmation' as const,
      tool_use_id: toolUseId,
      result: allowed ? ('allow' as const) : ('deny' as const),
      ...(allowed ? {} : { deny_message: DENY_MESSAGE }),
    });
  }
  await events.send(sessionId, { events: decisions });
}

function before(processedAt: string | null | undefined, since: string | null): boolean {
  if (!processedAt || !since) return false;
  return instant(processedAt) < instant(since);
}

/**
 * An ISO-8601 timestamp as nanoseconds since the epoch. `Date.parse` alone
 * keeps only milliseconds; the server's timestamps can be finer than that.
 */
function instant(value: string): bigint {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(value);
  if (!match) return BigInt(Date.parse(value)) * 1_000_000n;
  const [, head, fraction = '', zone] = match;
  return BigInt(Date.parse(head + zone)) * 1_000_000n + BigInt(fraction.padEnd(9, '0').slice(0, 9));
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join(' ');
}

function shorten(line: string): string {
  return line.length <= PREVIEW_CHARS ? line : `${line.slice(0, PREVIEW_CHARS - 1)}…`;
}
