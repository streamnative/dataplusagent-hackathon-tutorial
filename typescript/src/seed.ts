/**
 * Load the login stream into your topic (Lab 0, in either course).
 *
 * Replays data/login_events.jsonl: 246 synthetic logins at a fictional bank, with
 * their timestamps moved to now. One of the accounts in it is under attack.
 *
 *     npm run seed
 *     npm run seed -- --force    # load another copy into a topic that already has events
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Kafka, logLevel } from 'kafkajs';

import { REPO_ROOT, kafkaClientConfig, loadConfig, runMain, type Config, type Stack } from './common.js';
import { loginProducer, publish, type LoginEvent } from './inject.js';

const EVENTS_FILE = join(REPO_ROOT, 'data', 'login_events.jsonl');
const SCHEMA_FILE = join(REPO_ROOT, 'schemas', 'login_events.avsc');

/** One login event per line. */
export function loadEvents(path: string = EVENTS_FILE): LoginEvent[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** The same events, moved in time so the newest one happens now. Every gap is kept. */
export function rebaseEvents(events: LoginEvent[], now: Date): LoginEvent[] {
  const shift = now.getTime() - Math.max(...events.map((event) => event.event_time));
  return events.map((event) => ({ ...event, event_time: event.event_time + shift, ingested_at: event.ingested_at + shift }));
}

/** How many events a topic holds, from each partition's low and high offsets. */
export function eventsInTopic(watermarks: Array<{ low: string; high: string }>): number {
  return watermarks.reduce((total, { low, high }) => total + Number(high) - Number(low), 0);
}

/** The seed cannot go ahead. The message says why and what to do, the way `sys.exit(message)` does in the Python path. */
export class SeedError extends Error {}

/** What countExisting uses from a kafkajs admin client: the real one fits, and so do the test fakes. */
export interface TopicAdmin {
  connect(): Promise<void>;
  listTopics(): Promise<string[]>;
  fetchTopicOffsets(topic: string): Promise<Array<{ low: string; high: string }>>;
  disconnect(): Promise<void>;
}

/** How many events the topic holds already. Stops the script when it cannot tell. */
export async function countExisting(admin: TopicAdmin, topic: string, stack: Stack = 'local'): Promise<number> {
  try {
    await admin.connect();
    // Listing every topic avoids a metadata request that could create a missing one.
    if (!(await admin.listTopics()).includes(topic)) {
      const course = stack === 'local' ? 'Local course' : 'Cloud course';
      throw new SeedError(`The topic ${topic} does not exist yet. Create it first: ${course}, Lab 0.`);
    }
    return eventsInTopic(await admin.fetchTopicOffsets(topic));
  } catch (err) {
    if (err instanceof SeedError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new SeedError(`Could not read ${topic}: ${reason}\nRun \`npm run doctor\` to check your setup.`);
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

function topicAdmin(config: Config): TopicAdmin {
  return new Kafka({ clientId: 'hello-seed', ...kafkaClientConfig(config), logLevel: logLevel.NOTHING, retry: { retries: 2 } }).admin();
}

/** Load the events into the topic, unless it holds some already. Returns what to tell the participant. */
export async function seed(
  config: Config,
  admin: TopicAdmin,
  write: (topic: string, events: LoginEvent[]) => Promise<string[]>,
  force = false,
): Promise<string> {
  const topic = config.get('LOGIN_TOPIC');
  const existing = await countExisting(admin, topic, config.stack);
  if (existing > 0 && !force) {
    throw new SeedError(`${topic} already holds ${existing} events, so it is seeded. To load another copy anyway: npm run seed -- --force`);
  }

  const events = rebaseEvents(loadEvents(), new Date());
  const errors = await write(topic, events);
  if (errors.length > 0) throw new SeedError(`Could not write to ${topic}: ${errors[0]}\nRun \`npm run doctor\` to check your setup.`);
  const accounts = new Set(events.map((event) => event.account_id)).size;
  return `Loaded ${events.length} logins for ${accounts} accounts into ${topic}.`;
}

async function main(): Promise<void> {
  const config = loadConfig(['KAFKA_BOOTSTRAP_SERVERS', 'SCHEMA_REGISTRY_URL', 'LOGIN_TOPIC']);
  // Registering the schema is what lets the streaming database decode the topic.
  const write = (topic: string, events: LoginEvent[]) =>
    publish(loginProducer(config, { schema: readFileSync(SCHEMA_FILE, 'utf8') }), topic, events);
  console.log(await seed(config, topicAdmin(config), write, process.argv.slice(2).includes('--force')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain(() =>
    main().catch((err: unknown) => {
      if (!(err instanceof SeedError)) throw err;
      console.error(err.message);
      process.exit(1);
    }),
  );
}
