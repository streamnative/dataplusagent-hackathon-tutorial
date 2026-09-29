/** doctor.ts: the decisions behind each check (the network probes are exercised end to end). */

import { describe, expect, it } from 'vitest';

import { checkLoginSchema, checkMcpTools, checkNode, checkOrcaBaseUrl, errorText, kafkaHint, parseMcpResponse } from '../src/doctor.js';

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
});

describe('checkMcpTools', () => {
  it('the MCP server must offer the three tools the agent uses', () => {
    const tools = ['sql_workspace_list_databases', 'sql_workspace_query', 'sql_workspace_insert_rows', 'sncloud_context_whoami'];

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
