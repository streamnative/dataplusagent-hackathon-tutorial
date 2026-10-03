/**
 * Inject a brute-force login burst into the login topic.
 *
 * Six failed logins from a new IP address, then a success: the classic
 * account-takeover pattern. The materialized view login_failures picks it up
 * within seconds, so the next time you ask, your agent sees it.
 *
 *     npm run inject
 */

import { randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { SchemaRegistry, SchemaType } from '@kafkajs/confluent-schema-registry';
import { Kafka, Partitioners, logLevel } from 'kafkajs';

import { kafkaClientConfig, loadConfig, runMain, schemaRegistryConfig, type Config } from './common.js';

export const FAILURES = 6;

export interface LoginEvent {
  event_id: string;
  event_type: string;
  event_time: number;
  ingested_at: number;
  schema_version: string;
  tenant_id: string;
  scenario_id: string;
  account_id: string;
  session_id: string;
  device_id: string;
  ip_address: string;
  country: string;
  region: string;
  city: string;
  latitude: number;
  longitude: number;
  result: 'FAILURE' | 'SUCCESS';
  auth_method: string;
  failure_reason: string | null;
  user_agent: string;
}

/** An account id outside the preloaded range, so it is easy to spot. */
export function newAccountId(): string {
  return `acct_9${String(randomInt(0, 1000)).padStart(3, '0')}`;
}

/** An address from TEST-NET-3, the range reserved for documentation. */
export function newIp(): string {
  return `203.0.113.${randomInt(2, 255)}`;
}

/** Six failed logins from one IP address, then a success, two seconds apart. */
export function buildBurst(accountId: string, ipAddress: string, now: Date): LoginEvent[] {
  return Array.from({ length: FAILURES + 1 }, (_, attempt) => {
    const success = attempt === FAILURES;
    const millis = now.getTime() + 2000 * attempt;
    return {
      event_id: randomUUID(),
      event_type: 'LOGIN_ATTEMPT',
      event_time: millis,
      ingested_at: millis,
      schema_version: '1.0',
      tenant_id: 'aegis_financial',
      scenario_id: 'hello_world_injection',
      account_id: accountId,
      session_id: `sess_inject_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      device_id: 'device_inject_0001',
      ip_address: ipAddress,
      country: 'RO',
      region: 'Bucharest',
      city: 'Bucharest',
      latitude: 44.4268,
      longitude: 26.1025,
      result: success ? 'SUCCESS' : 'FAILURE',
      auth_method: 'PASSWORD',
      failure_reason: success ? null : 'INVALID_PASSWORD',
      user_agent: 'python-requests/2.32',
    };
  });
}

/** What publish uses from a producer: the one from loginProducer fits, and so do the test fakes. */
export interface LoginProducer {
  send(topic: string, messages: Array<{ key: string; value: LoginEvent }>): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Write the records, each keyed by its account, and wait for Kafka to confirm them.
 *
 * Returns what went wrong, if anything.
 */
export async function publish(producer: LoginProducer, topic: string, records: LoginEvent[]): Promise<string[]> {
  try {
    // Encoding looks the schema up in Schema Registry, so it can fail here too.
    await producer.send(
      topic,
      records.map((record) => ({ key: record.account_id, value: record })),
    );
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  } finally {
    await producer.disconnect().catch(() => {});
  }
  return [];
}

/**
 * A producer of Avro login events.
 *
 * By default it writes with the schema the topic already has and never registers
 * a new one. Pass `schema` to register it first: that is how seed.ts fills a new topic.
 */
export function loginProducer(config: Config, { schema }: { schema?: string } = {}): LoginProducer {
  const registry = new SchemaRegistry(schemaRegistryConfig(config));
  const kafka = new Kafka({ clientId: 'hello-inject', ...kafkaClientConfig(config), logLevel: logLevel.NOTHING, retry: { retries: 2 } });
  const producer = kafka.producer({ idempotent: false, allowAutoTopicCreation: false, createPartitioner: Partitioners.DefaultPartitioner });

  return {
    async send(topic, messages) {
      const subject = `${topic}-value`;
      const schemaId = schema
        ? (await registry.register({ type: SchemaType.AVRO, schema }, { subject })).id
        : await registry.getLatestSchemaId(subject);
      const encoded = await Promise.all(messages.map(async ({ key, value }) => ({ key, value: await registry.encode(schemaId, value) })));
      await producer.connect();
      await producer.send({ topic, acks: -1, messages: encoded });
    },
    disconnect: () => producer.disconnect(),
  };
}

async function main(): Promise<void> {
  const config = loadConfig(['KAFKA_BOOTSTRAP_SERVERS', 'SCHEMA_REGISTRY_URL', 'LOGIN_TOPIC']);
  const topic = config.get('LOGIN_TOPIC');
  const producer = loginProducer(config);

  const accountId = newAccountId();
  const ipAddress = newIp();
  const errors = await publish(producer, topic, buildBurst(accountId, ipAddress, new Date()));
  if (errors.length > 0) {
    console.error(`Could not write to ${topic}: ${errors[0]}\nRun \`npm run doctor\` to check your Kafka access.`);
    process.exit(1);
  }
  console.log(`Injected ${FAILURES} failed logins + 1 success for ${accountId} from ${ipAddress} into ${topic}.`);
  console.log(`Ask your agent again, or run this SQL:  SELECT * FROM login_failures WHERE account_id = '${accountId}';`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain(main);
}
