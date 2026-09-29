/**
 * In-memory stand-ins for the parts of the Orca API the tutorial touches.
 *
 * The fakes mirror the real SDK surface (method names, arguments, return
 * shapes) and throw the real SDK error classes, so the code under test runs
 * the same way it does against a live Agent Engine.
 */

import { ConflictError, NotFoundError } from '@runorca/orca-sdk';
import type {
  Agent,
  AgentCreateParams,
  AgentMcpServerInput,
  AgentUpdateParams,
  CredentialCreateParams,
  Environment,
  EnvironmentCreateParams,
  EventSendParams,
  EventSendResponse,
  SessionEvent,
  SessionEventInput,
  Vault,
  VaultCreateParams,
  VaultCredential,
} from '@runorca/orca-sdk';

export const NOW = '2026-10-07T10:00:00Z';

const CLOUD_CONFIG = {
  type: 'cloud',
  packages: { type: 'packages', apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
  networking: { type: 'unrestricted' },
} as const;

export type RawEvent = { id: string; type: string; [field: string]: unknown };

export function notFound(): NotFoundError {
  return new NotFoundError(404, { message: 'not found' }, 'not found', new Headers());
}

export function conflict(): ConflictError {
  return new ConflictError(409, { message: 'name taken' }, 'name taken', new Headers());
}

/** A server-sent-event stream: yields whatever the session has queued. */
class FakeStream implements AsyncIterable<SessionEvent> {
  constructor(private readonly queue: SessionEvent[]) {}

  async *[Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    while (this.queue.length > 0) {
      yield this.queue.shift()!;
    }
  }
}

/**
 * A scripted session.
 *
 * `reactions[i]` are the events the agent emits after the i-th `send()` call.
 * `history` models a server whose stream replays the whole transcript on
 * connect. `echoUserEvents` controls whether sent events reappear on the
 * stream (servers differ).
 */
export class FakeSessionEvents {
  readonly calls: Array<['stream', string] | ['send', string, SessionEventInput[]]> = [];
  private readonly reactions: RawEvent[][];
  private readonly history: SessionEvent[];
  private readonly queue: SessionEvent[] = [];
  private readonly echo: boolean;
  private ticks = 0;
  private ids = 0;

  constructor(reactions: RawEvent[][], options: { history?: RawEvent[]; echoUserEvents?: boolean } = {}) {
    this.reactions = [...reactions];
    this.history = [...(options.history ?? [])] as SessionEvent[];
    this.echo = options.echoUserEvents ?? true;
  }

  private now(): string {
    this.ticks += 1;
    return `2026-10-07T10:00:${String(this.ticks).padStart(2, '0')}.000Z`;
  }

  async stream(sessionId: string): Promise<AsyncIterable<SessionEvent>> {
    this.calls.push(['stream', sessionId]);
    this.queue.push(...this.history);
    return new FakeStream(this.queue);
  }

  async send(sessionId: string, params: EventSendParams): Promise<EventSendResponse> {
    this.calls.push(['send', sessionId, params.events]);
    const persisted = params.events.map((e) => ({ id: `evt_user_${++this.ids}`, processed_at: this.now(), ...e }) as SessionEvent);
    if (this.echo) this.queue.push(...persisted);
    for (const reaction of this.reactions.shift() ?? []) {
      this.queue.push({ processed_at: this.now(), ...reaction } as SessionEvent);
    }
    return { data: persisted };
  }
}

export function clientWithEvents(events: FakeSessionEvents) {
  return { sessions: { events } };
}

// -- agents / environments / vaults ------------------------------------------

export function makeAgent(id: string, version: number, params: AgentCreateParams, archived = false): Agent {
  return {
    id,
    type: 'agent',
    name: params.name,
    description: null,
    model: { id: typeof params.model === 'string' ? params.model : params.model.id },
    system: params.system ?? null,
    mcp_servers: (params.mcp_servers ?? []).map((s) => ({ name: s.name, type: 'url', url: s.url })),
    tools: params.tools ?? [],
    skills: [],
    multiagent: null,
    metadata: params.metadata ?? {},
    version,
    created_at: NOW,
    updated_at: NOW,
    archived_at: archived ? '2026-10-07T11:00:00Z' : null,
  };
}

export class FakeAgents {
  readonly store = new Map<string, Agent>();
  readonly calls: unknown[][] = [];

  async create(params: AgentCreateParams): Promise<Agent> {
    this.calls.push(['create', params]);
    const agent = makeAgent(`agent_${this.store.size + 1}`, 1, params);
    this.store.set(agent.id, agent);
    return agent;
  }

  async retrieve(agentId: string): Promise<Agent> {
    this.calls.push(['retrieve', agentId]);
    const agent = this.store.get(agentId);
    if (!agent) throw notFound();
    return agent;
  }

  async archive(agentId: string): Promise<Agent> {
    this.calls.push(['archive', agentId]);
    const agent = this.store.get(agentId);
    if (!agent) throw notFound();
    const archived = { ...agent, archived_at: NOW };
    this.store.set(agentId, archived);
    return archived;
  }

  async update(agentId: string, params: AgentUpdateParams): Promise<Agent> {
    this.calls.push(['update', agentId, params]);
    const current = this.store.get(agentId)!;
    if (params.version !== current.version) throw conflict();
    const { version: _version, ...changes } = params;
    const merged = {
      name: changes.name ?? current.name,
      model: changes.model ?? current.model.id,
      system: changes.system ?? current.system,
      mcp_servers: (changes.mcp_servers ?? current.mcp_servers) as AgentMcpServerInput[],
      tools: changes.tools ?? current.tools,
      metadata: (changes.metadata ?? current.metadata) as Record<string, string>,
    };
    const agent = makeAgent(agentId, current.version + 1, merged);
    this.store.set(agentId, agent);
    return agent;
  }
}

export class FakeEnvironments {
  readonly store = new Map<string, Environment>();
  readonly taken: Set<string>;
  readonly calls: unknown[][] = [];

  constructor(takenNames: Iterable<string> = []) {
    this.taken = new Set(takenNames);
  }

  async create(params: EnvironmentCreateParams): Promise<Environment> {
    this.calls.push(['create', params.name]);
    if (this.taken.has(params.name)) throw conflict();
    this.taken.add(params.name);
    const environment: Environment = {
      id: `env_${this.store.size + 1}`,
      type: 'environment',
      name: params.name,
      description: '',
      config: CLOUD_CONFIG as unknown as Environment['config'],
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
      archived_at: null,
    };
    this.store.set(environment.id, environment);
    return environment;
  }

  async retrieve(environmentId: string): Promise<Environment> {
    this.calls.push(['retrieve', environmentId]);
    const environment = this.store.get(environmentId);
    if (!environment) throw notFound();
    return environment;
  }

  async delete(environmentId: string): Promise<void> {
    this.calls.push(['delete', environmentId]);
    if (!this.store.delete(environmentId)) throw notFound();
  }
}

export class FakeCredentials {
  readonly store = new Map<string, VaultCredential[]>();
  readonly calls: unknown[][] = [];

  async create(vaultId: string, params: CredentialCreateParams): Promise<VaultCredential> {
    this.calls.push(['create', vaultId, params.auth, params.display_name]);
    const count = [...this.store.values()].reduce((n, list) => n + list.length, 0);
    const auth = params.auth as { type: 'static_bearer'; mcp_server_url: string };
    const credential: VaultCredential = {
      id: `cred_${count + 1}`,
      type: 'vault_credential',
      vault_id: vaultId,
      display_name: params.display_name ?? null,
      auth: { type: auth.type, mcp_server_url: auth.mcp_server_url }, // the token is never returned
      metadata: {},
      archived_at: null,
      created_at: NOW,
      updated_at: NOW,
    };
    this.store.set(vaultId, [...(this.store.get(vaultId) ?? []), credential]);
    return credential;
  }

  async list(vaultId: string): Promise<{ data: VaultCredential[] }> {
    this.calls.push(['list', vaultId]);
    return { data: [...(this.store.get(vaultId) ?? [])] };
  }
}

export class FakeVaults {
  readonly store = new Map<string, Vault>();
  readonly calls: unknown[][] = [];
  readonly credentials = new FakeCredentials();

  async create(params: VaultCreateParams): Promise<Vault> {
    this.calls.push(['create', params.display_name]);
    const vault: Vault = {
      id: `vlt_${this.store.size + 1}`,
      type: 'vault',
      display_name: params.display_name,
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
      archived_at: null,
    };
    this.store.set(vault.id, vault);
    return vault;
  }

  async retrieve(vaultId: string): Promise<Vault> {
    this.calls.push(['retrieve', vaultId]);
    const vault = this.store.get(vaultId);
    if (!vault) throw notFound();
    return vault;
  }

  async delete(vaultId: string): Promise<void> {
    this.calls.push(['delete', vaultId]);
    if (!this.store.delete(vaultId)) throw notFound();
  }
}

export function fakeClient(takenEnvNames: Iterable<string> = []) {
  return { agents: new FakeAgents(), environments: new FakeEnvironments(takenEnvNames), vaults: new FakeVaults() };
}
