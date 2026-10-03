/** loginProducer: the Avro producer `npm run inject` and `npm run seed` share. */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import avro from 'avsc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Config } from '../src/common.js';
import { buildBurst, loginProducer } from '../src/inject.js';

// kafkajs without a broker: what the producer was configured with, and what it was asked to send.
const kafka = vi.hoisted(() => ({
  configs: [] as Array<Record<string, any>>,
  calls: [] as string[],
  sent: [] as Array<{ topic: string; acks: number; messages: Array<{ key: string; value: Buffer }> }>,
}));

vi.mock('kafkajs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('kafkajs')>()),
  Kafka: class {
    constructor(config: Record<string, any>) {
      kafka.configs.push(config);
    }

    producer() {
      return {
        connect: async () => void kafka.calls.push('connect'),
        send: async (record: (typeof kafka.sent)[number]) => void (kafka.calls.push('send'), kafka.sent.push(record)),
        disconnect: async () => void kafka.calls.push('disconnect'),
      };
    }
  },
}));

const TOPIC = 'security.login_events';
const SUBJECT = `${TOPIC}-value`;
const SCHEMA_ID = 7;
const SCHEMA_TEXT = readFileSync(new URL('../../schemas/login_events.avsc', import.meta.url), 'utf8');
const SCHEMA = avro.Type.forSchema(JSON.parse(SCHEMA_TEXT));
const [RECORD] = buildBurst('acct_9123', '203.0.113.77', new Date(Date.UTC(2026, 9, 7, 10, 30)));

/** A stand-in for the Schema Registry's REST API: the calls a producer makes, and nothing else. */
class StubRegistry {
  readonly requests: Array<{ line: string; authorization?: string; body: string }> = [];
  subjects = [SUBJECT];
  private server!: Server;

  async start(): Promise<string> {
    this.server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const line = `${request.method} ${request.url}`;
      this.requests.push({ line, authorization: request.headers.authorization, body });
      const [status, reply] = this.answer(line);
      response.writeHead(status, { 'Content-Type': 'application/vnd.schemaregistry.v1+json' });
      response.end(JSON.stringify(reply));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private answer(line: string): [number, unknown] {
    const subject = this.subjects.find((name) => line.includes(`/${name}`));
    if (line === `GET /schemas/ids/${SCHEMA_ID}`) return [200, { schema: SCHEMA_TEXT }];
    if (subject && line === `GET /subjects/${subject}/versions/latest`) return [200, { subject, version: 1, id: SCHEMA_ID, schema: SCHEMA_TEXT }];
    if (line.startsWith('POST /subjects/') && line.endsWith('/versions')) return [200, { id: SCHEMA_ID }];
    if (line.startsWith('PUT /config/')) return [200, { compatibility: 'BACKWARD' }];
    // What the local registry (Karapace) answers for a subject it has no entry for.
    return [404, { error_code: 40401, message: `Subject '${line.split('/')[2]}' not found.` }];
  }

  lines(): string[] {
    return this.requests.map((request) => request.line);
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** Undo the Confluent wire format: a zero byte, the schema id, then the Avro record. */
function decode(value: Buffer): { schemaId: number; record: unknown } {
  expect(value.readUInt8(0)).toBe(0);
  return { schemaId: value.readUInt32BE(1), record: SCHEMA.fromBuffer(value.subarray(5)) };
}

let registry: StubRegistry;
let local: Config;
let cloud: Config;

beforeEach(async () => {
  kafka.configs.length = 0;
  kafka.calls.length = 0;
  kafka.sent.length = 0;
  registry = new StubRegistry();
  const url = await registry.start();
  local = new Config({ TUTORIAL_STACK: 'local', KAFKA_BOOTSTRAP_SERVERS: '127.0.0.1:29092', SCHEMA_REGISTRY_URL: url }, 'jane');
  cloud = new Config(
    { KAFKA_BOOTSTRAP_SERVERS: 'kafka.example.com:9093', SCHEMA_REGISTRY_URL: url, SN_SERVICE_ACCOUNT: 'team-07@o-test.auth.streamnative.cloud', SN_API_KEY: 'the-api-key' },
    'jane',
  );
});

afterEach(() => registry.stop());

describe('loginProducer', () => {
  it('writes with the schema the topic already has, and never registers one', async () => {
    await loginProducer(local).send(TOPIC, [{ key: 'acct_9123', value: RECORD }]);

    expect(registry.lines()).toEqual([`GET /subjects/${SUBJECT}/versions/latest`, `GET /schemas/ids/${SCHEMA_ID}`]);
    expect(kafka.calls).toEqual(['connect', 'send']);
  });

  it('sends each record under its key, in the format RisingWave decodes', async () => {
    await loginProducer(local).send(TOPIC, [{ key: 'acct_9123', value: RECORD }]);

    const [{ topic, acks, messages }] = kafka.sent;
    expect([topic, acks]).toEqual([TOPIC, -1]);
    expect(messages.map((message) => message.key)).toEqual(['acct_9123']);
    expect(decode(messages[0].value)).toEqual({ schemaId: SCHEMA_ID, record: RECORD });
  });

  it('registers the schema it is given, then writes with it', async () => {
    await loginProducer(local, { schema: SCHEMA_TEXT }).send(TOPIC, [{ key: 'acct_9123', value: RECORD }]);

    const registered = registry.requests.filter((request) => request.line === `POST /subjects/${SUBJECT}/versions`);
    expect(registered.map((request) => JSON.parse(request.body).schema)).toEqual([SCHEMA_TEXT]);
    expect(registry.lines()).not.toContain(`GET /subjects/${SUBJECT}/versions/latest`);
    expect(decode(kafka.sent[0].messages[0].value)).toEqual({ schemaId: SCHEMA_ID, record: RECORD });
  });

  it('a topic without a schema is reported before Kafka is contacted', async () => {
    registry.subjects = [];

    await expect(loginProducer(local).send(TOPIC, [{ key: 'acct_9123', value: RECORD }])).rejects.toThrow(/not found/);

    expect(kafka.calls).toEqual([]);
  });

  it('on the local stack it logs in to neither Kafka nor the registry', async () => {
    await loginProducer(local).send(TOPIC, [{ key: 'acct_9123', value: RECORD }]);

    expect(kafka.configs[0].brokers).toEqual(['127.0.0.1:29092']);
    expect([kafka.configs[0].ssl, kafka.configs[0].sasl]).toEqual([undefined, undefined]);
    expect(registry.requests.map((request) => request.authorization)).toEqual([undefined, undefined]);
  });

  it('on the cloud stack it logs in to both with the service account', async () => {
    await loginProducer(cloud).send(TOPIC, [{ key: 'acct_9123', value: RECORD }]);

    expect(kafka.configs[0]).toMatchObject({
      brokers: ['kafka.example.com:9093'],
      ssl: true,
      sasl: { mechanism: 'plain', username: 'team-07@o-test.auth.streamnative.cloud', password: 'the-api-key' },
    });
    const basic = `Basic ${Buffer.from('team-07@o-test.auth.streamnative.cloud:the-api-key').toString('base64')}`;
    expect(registry.requests.map((request) => request.authorization)).toEqual([basic, basic]);
  });
});
