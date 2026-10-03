/** doctor.ts: the decisions behind each check (the network probes are exercised end to end). */

import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  agentEngineFix,
  check as newCheck,
  checkLoginSchema,
  checkMcpQuery,
  checkMcpTools,
  checkNode,
  checkOrcaBaseUrl,
  errorText,
  kafkaHint,
  mcpHeaders,
  parseMcpResponse,
  requiredFor,
  schemaRegistryHint,
  summarize,
} from '../src/doctor.js';

describe('checkOrcaBaseUrl', () => {
  it.each(['https://ws.example.com', 'https://ws.example.com/'])('a host root URL passes: %s', (url) => {
    expect(checkOrcaBaseUrl(url).ok).toBe(true);
  });

  it.each(['https://ws.example.com/v1', 'https://ws.example.com/v1/registry', 'https://ws.example.com/api/v1'])(
    'a URL with an API path fails and suggests the host root: %s',
    (url) => {
      const check = checkOrcaBaseUrl(url);

      expect(check.ok).toBe(false);
      expect(check.fix).toContain('https://ws.example.com');
    },
  );

  it('a URL without https fails', () => {
    expect(checkOrcaBaseUrl('ws.example.com').ok).toBe(false);
    expect(checkOrcaBaseUrl('http://ws.example.com').ok).toBe(false);
  });
});

describe('checkNode', () => {
  it('Node older than 20 fails', () => {
    expect(checkNode('20.20.2').ok).toBe(true);
    expect(checkNode('24.1.0').ok).toBe(true);
    expect(checkNode('18.19.1').ok).toBe(false);
  });
});

const LOGIN_FIELDS = ['event_id', 'event_time', 'account_id', 'ip_address', 'result', 'failure_reason', 'auth_method'];

describe('checkLoginSchema', () => {
  it('passes when the topic schema has every field the SQL uses', () => {
    expect(checkLoginSchema(LOGIN_FIELDS).ok).toBe(true);
  });

  it('names a missing field', () => {
    const check = checkLoginSchema(LOGIN_FIELDS.filter((f) => f !== 'ip_address'));

    expect(check.ok).toBe(false);
    expect(check.detail).toContain('ip_address');
  });

  it('an `outcome` field instead of `result` gets a specific fix', () => {
    const check = checkLoginSchema([...LOGIN_FIELDS.filter((f) => f !== 'result'), 'outcome']);

    expect(check.ok).toBe(false);
    expect(check.fix).toContain('outcome');
  });

  it.each(['cloud', 'local'] as const)('the `outcome` fix names SQL files that exist for the %s stack', (stack) => {
    const check = checkLoginSchema([...LOGIN_FIELDS.filter((f) => f !== 'result'), 'outcome'], stack);

    const named = check.fix?.match(/sql\/[\w/.]+\.sql/g) ?? [];

    expect(named).toHaveLength(2);
    for (const name of named) {
      expect(name.startsWith(`sql/${stack}/`)).toBe(true);
      expect(existsSync(new URL(`../../${name}`, import.meta.url))).toBe(true);
    }
  });
});

describe('checkMcpTools', () => {
  it('the MCP server must offer the three tools the agent uses', () => {
    const tools = ['sql_workspace_list_databases', 'sql_workspace_query', 'sql_workspace_describe_table', 'sql_workspace_insert_rows', 'sncloud_context_whoami'];

    expect(checkMcpTools(tools).ok).toBe(true);
  });

  it('names the missing tools', () => {
    const check = checkMcpTools(['sql_workspace_query']);

    expect(check.ok).toBe(false);
    expect(check.detail).toContain('sql_workspace_list_databases');
    expect(check.detail).toContain('sql_workspace_insert_rows');
  });
});

describe('parseMcpResponse', () => {
  it('parses a plain JSON response', () => {
    const body = '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"sql_workspace_query"}]}}';

    expect(parseMcpResponse('application/json', body, 2)).toEqual({ tools: [{ name: 'sql_workspace_query' }] });
  });

  it('parses an event-stream response and picks the matching id', () => {
    const body =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n' +
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"sql_workspace_query"}]}}\n\n';

    expect(parseMcpResponse('text/event-stream; charset=utf-8', body, 2)).toEqual({ tools: [{ name: 'sql_workspace_query' }] });
  });

  it('throws with the message of an error response', () => {
    const body = '{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"forbidden: no MCP permission"}}';

    expect(() => parseMcpResponse('application/json', body, 2)).toThrow(/no MCP permission/);
  });
});

describe('kafkaHint', () => {
  it.each([
    ['KafkaError{code=_AUTHENTICATION,val=-169,str="SASL authentication error: Authentication failed"}', 'SN_SERVICE_ACCOUNT'],
    ['KafkaError{code=TOPIC_AUTHORIZATION_FAILED,val=29,str="Broker: Topic authorization failed"}', 'rolebinding'],
    ["KafkaError{code=_TRANSPORT,val=-195,str=\"Failed to resolve 'bad-host:9093'\"}", 'KAFKA_BOOTSTRAP_SERVERS'],
    // The same failures, as kafkajs reports them.
    ['KafkaJSSASLAuthenticationError: SASL PLAIN authentication failed: Authentication failed', 'SN_SERVICE_ACCOUNT'],
    ['KafkaJSProtocolError: Not authorized to access topics: [Topic authorization failed]', 'rolebinding'],
    ['KafkaJSConnectionError: Connection error: getaddrinfo ENOTFOUND bad-host', 'KAFKA_BOOTSTRAP_SERVERS'],
  ])('%s maps to a concrete fix', (error, advice) => {
    expect(kafkaHint(error)).toContain(advice);
  });
});

describe('errorText', () => {
  it("shows why fetch failed, not just that it did", () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND registry.example.com'), { code: 'ENOTFOUND' });

    expect(errorText(new TypeError('fetch failed', { cause }))).toContain('ENOTFOUND registry.example.com');
  });

  it('keeps a plain error message as it is', () => {
    expect(errorText(new Error('HTTP 401: unauthorized'))).toBe('HTTP 401: unauthorized');
  });
});


describe('local Agent Engine URL', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts loopback HTTP on %s', (host) => {
    expect(checkOrcaBaseUrl(`http://${host}:8080`).ok).toBe(true);
  });
  it('still requires HTTPS for a non-local host', () => {
    expect(checkOrcaBaseUrl('http://ws.example.com').ok).toBe(false);
  });
  it('suggests the local host root when a path was added', () => {
    const result = checkOrcaBaseUrl('http://127.0.0.1:8080/v1');
    expect(result.ok).toBe(false);
    expect(result.fix).toContain('http://127.0.0.1:8080');
  });
});

describe('the two stacks', () => {
  it('the cloud stack needs the team card', () => {
    const required = requiredFor('cloud');

    expect(required).toEqual(expect.arrayContaining(['SN_API_KEY', 'SN_SERVICE_ACCOUNT', 'SN_MCP_URL']));
    expect(required).not.toContain('RW_MCP_URL');
  });

  it('the local stack needs no team card values', () => {
    const required = requiredFor('local');

    expect(required).toEqual(expect.arrayContaining(['ORCA_API_KEY', 'KAFKA_BOOTSTRAP_SERVERS', 'SCHEMA_REGISTRY_URL', 'RW_MCP_URL', 'RW_MCP_LOCAL_URL']));
    expect(required.filter((name) => name.startsWith('SN_'))).toEqual([]);
  });

  it('the local MCP server must offer the tools the local agent uses', () => {
    const offered = ['run_select_query', 'describe_table', 'insert_multiple_rows', 'drop_table', 'list_databases'];

    expect(checkMcpTools(offered, 'local').ok).toBe(true);
  });

  it('missing local MCP tools are named and the fix is local', () => {
    const check = checkMcpTools(['run_select_query'], 'local');

    expect(check.ok).toBe(false);
    expect(check.detail).toContain('describe_table');
    expect(check.detail).toContain('insert_multiple_rows');
    expect(check.fix).not.toContain('facilitator');
  });

  it('a SELECT through MCP that returns a row passes', () => {
    expect(checkMcpQuery('[\n  {\n    "ready": 1\n  }\n]').ok).toBe(true);
  });

  it.each(['Error executing query: connection refused', '[]', 'not json'])(
    'a SELECT through MCP that returns no row fails with what came back: %s',
    (text) => {
      const check = checkMcpQuery(text);

      expect(check.ok).toBe(false);
      expect(check.detail).toContain(text);
    },
  );

  it.each([
    ['KafkaError{code=_TRANSPORT,val=-195,str="127.0.0.1:29092/bootstrap: Connect to ipv4#127.0.0.1:29092 failed: Connection refused"}', 'local/compose.yaml'],
    // The same failure, as kafkajs reports it.
    ['KafkaJSNumberOfRetriesExceeded: Connection error: connect ECONNREFUSED 127.0.0.1:29092', 'local/compose.yaml'],
    ['not found', 'Lab 0'],
  ])('local Kafka error %s points at the local stack', (error, advice) => {
    const hint = kafkaHint(error, 'local');

    expect(hint).toContain(advice);
    expect(hint).not.toContain('facilitator');
    expect(hint).not.toContain('team card');
  });

  it('a local schema that is not registered yet points at the seeder', () => {
    const hint = schemaRegistryHint(`HTTP 404: {"error_code":40401,"message":"Subject 'security.login_events-value' not found."}`, 'local');

    expect(hint).toContain('npm run seed');
    expect(hint).toContain('Lab 0');
  });

  it('an unreachable local schema registry points at the streaming stack', () => {
    const hint = schemaRegistryHint('fetch failed: connect ECONNREFUSED 127.0.0.1:18081', 'local');

    expect(hint).toContain('local/compose.yaml');
    expect(hint).not.toContain('seed');
  });

  it.each(['fetch failed: connect ECONNREFUSED 10.0.0.1:443', 'HTTP 401: unauthorized'])('cloud schema registry error %s points at SCHEMA_REGISTRY_URL', (error) => {
    const hint = schemaRegistryHint(error);

    expect(hint).toContain('SCHEMA_REGISTRY_URL');
    expect(hint).not.toContain('compose');
  });

  // On StreamNative Cloud each participant creates and loads their own topic.

  it('a cloud topic that is not there yet points at Lab 0', () => {
    const hint = kafkaHint('security.login_events: not found', 'cloud');

    expect(hint).toContain('Cloud course, Lab 0');
    expect(hint).not.toContain('facilitator');
  });

  it('a cloud schema that is not registered yet points at the seeder', () => {
    // What StreamNative Cloud's registry says: it names the subject with its namespace.
    const hint = schemaRegistryHint('HTTP 404: {"error_code":40401,"message":"Subject \'public/default/security.login_events-value\' not found."}');

    expect(hint).toContain('npm run seed');
    expect(hint).toContain('Cloud course, Lab 0');
  });

  it.each([
    ['an unreachable cluster', kafkaHint('Failed to resolve kafka.example.com:9093', 'cloud')],
    ['an http URL', checkOrcaBaseUrl('http://ws.example.com').fix ?? ''],
    ['a rejected key', agentEngineFix(401, 'cloud')],
    ['a URL that is not a registry', agentEngineFix(404, 'cloud')],
  ])('the cloud fix for %s names your instance, not a team card', (_case, hint) => {
    expect(hint).not.toContain('team card');
  });

  it('the MCP probe sends a bearer token only when it has one', () => {
    expect(mcpHeaders('the-token').Authorization).toBe('Bearer the-token');
    expect(Object.keys(mcpHeaders())).not.toContain('Authorization');
  });
});

describe('the verdict', () => {
  it('all checks passing is a zero exit', () => {
    const { code, verdict } = summarize([newCheck('a', true), newCheck('b', true)]);

    expect(code).toBe(0);
    expect(verdict).toContain('ready');
  });

  it('a failed check is a nonzero exit and is counted', () => {
    const { code, verdict } = summarize([newCheck('a', true), newCheck('b', false, 'boom', 'fix it')]);

    expect(code).toBe(1);
    expect(verdict).toContain('1 check(s) failed');
  });

  it('a waiting check does not fail the doctor', () => {
    const waiting = newCheck('MCP OAuth', false, 'no tutorial vault yet', 'Lab 3 authorizes it.', { wait: true });

    const { code, verdict } = summarize([newCheck('a', true), waiting]);

    expect(code).toBe(0);
    expect(verdict).toContain('1 check(s) wait');
  });

  it('a failure wins over a waiting check', () => {
    const waiting = newCheck('MCP OAuth', false, '', '', { wait: true });

    const { code, verdict } = summarize([newCheck('a', false), waiting]);

    expect(code).toBe(1);
    expect(verdict).toContain('1 check(s) failed');
  });

  it('each check is labelled', () => {
    expect(newCheck('a', true).label).toBe('PASS');
    expect(newCheck('a', false).label).toBe('FAIL');
    expect(newCheck('a', false, '', '', { wait: true }).label).toBe('WAIT');
  });
});
