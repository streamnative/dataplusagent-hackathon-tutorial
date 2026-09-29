/**
 * Inject a brute-force login burst into your team's login topic.
 *
 * Six failed logins from a new IP address, then a success: the classic
 * account-takeover pattern. The materialized view login_failures picks it up
 * within seconds, so the next time you ask, your agent sees it.
 *
 *     npm run inject
 */

import { randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { SchemaRegistry } from '@kafkajs/confluent-schema-registry';
import { Kafka, Partitioners, logLevel } from 'kafkajs';

import { loadConfig, runMain } from './common.js';

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

async function main(): Promise<void> {
  const config = loadConfig(['KAFKA_BOOTSTRAP_SERVERS', 'SCHEMA_REGISTRY_URL', 'SN_SERVICE_ACCOUNT', 'SN_API_KEY', 'LOGIN_TOPIC']);
  const topic = config.get('LOGIN_TOPIC');
  const username = config.get('SN_SERVICE_ACCOUNT');
  const password = config.get('SN_API_KEY');

  const registry = new SchemaRegistry({ host: config.get('SCHEMA_REGISTRY_URL'), auth: { username, password } });
  const kafka = new Kafka({
    clientId: 'hello-inject',
    brokers: config
      .get('KAFKA_BOOTSTRAP_SERVERS')
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean),
    ssl: true,
    // StreamNative Cloud: the service-account principal, and the raw API key.
    sasl: { mechanism: 'plain', username, password },
    logLevel: logLevel.NOTHING,
    retry: { retries: 2 },
  });
  const producer = kafka.producer({ idempotent: false, allowAutoTopicCreation: false, createPartitioner: Partitioners.DefaultPartitioner });

  const accountId = newAccountId();
  const ipAddress = newIp();
  let failure: unknown = null;
  try {
    // Write with the schema the topic already has; never register a new one.
    const schemaId = await registry.getLatestSchemaId(`${topic}-value`);
    const messages = await Promise.all(
      buildBurst(accountId, ipAddress, new Date()).map(async (record) => ({ key: accountId, value: await registry.encode(schemaId, record) })),
    );
    await producer.connect();
    await producer.send({ topic, acks: -1, messages });
  } catch (err) {
    failure = err;
  } finally {
    await producer.disconnect().catch(() => {});
  }

  if (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    console.error(`Could not write to ${topic}: ${reason}\nRun \`npm run doctor\` to check your Kafka access.`);
    process.exit(1);
  }
  console.log(`Injected ${FAILURES} failed logins + 1 success for ${accountId} from ${ipAddress} into ${topic}.`);
  console.log(`Ask your agent again, or check in SQL Studio:  SELECT * FROM login_failures WHERE account_id = '${accountId}';`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain(main);
}
