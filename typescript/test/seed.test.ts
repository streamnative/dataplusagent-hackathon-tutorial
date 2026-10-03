/** seed.ts: the login stream the Local course loads into your topic. */

import { readFileSync } from 'node:fs';
import { BlockList } from 'node:net';

import avro from 'avsc';
import { describe, expect, it } from 'vitest';

import type { LoginEvent } from '../src/inject.js';
import { SeedError, countExisting, eventsInTopic, loadEvents, rebaseEvents } from '../src/seed.js';

const TOPIC = 'security.login_events';
const SCHEMA = avro.Type.forSchema(JSON.parse(readFileSync(new URL('../../schemas/login_events.avsc', import.meta.url), 'utf8')));
const NOW = new Date(Date.UTC(2026, 9, 7, 10, 30));
// The ranges reserved for documentation (RFC 5737): no real host has these addresses.
const DOCUMENTATION_RANGES = new BlockList();
for (const network of ['192.0.2.0', '198.51.100.0', '203.0.113.0']) DOCUMENTATION_RANGES.addSubnet(network, 24);

const count = (events: LoginEvent[], result: string) => events.filter((e) => e.result === result).length;

describe('the seed', () => {
  it("every seed event matches the topic's Avro schema", () => {
    for (const record of loadEvents()) {
      const problems: string[] = [];
      SCHEMA.isValid(record, { errorHook: (path) => problems.push(path.join('.')) });
      expect(problems).toEqual([]);
      expect(SCHEMA.fromBuffer(SCHEMA.toBuffer(record))).toEqual(record);
    }
  });

  it('holds the 246 logins for 91 accounts that Lab 0 says it loads', () => {
    const events = loadEvents();

    expect(events).toHaveLength(246);
    expect(new Set(events.map((e) => e.account_id)).size).toBe(91);
  });

  it('holds one account under attack', () => {
    const logins = loadEvents().filter((e) => e.account_id === 'acct_0042');

    expect(count(logins, 'FAILURE')).toBe(5);
    expect(count(logins, 'SUCCESS')).toBe(2);
    expect(new Set(logins.map((e) => e.ip_address)).size).toBe(2);
    // The takeover: every failure comes before the attacker's success.
    const attack = logins.filter((e) => e.scenario_id !== 'baseline').sort((a, b) => a.event_time - b.event_time);
    expect(attack.map((e) => e.result)).toEqual([...Array(5).fill('FAILURE'), 'SUCCESS']);
  });

  it('no other account looks like a takeover', () => {
    const byAccount = new Map<string, LoginEvent[]>();
    for (const event of loadEvents()) byAccount.set(event.account_id, [...(byAccount.get(event.account_id) ?? []), event]);

    const suspects = [...byAccount].filter(([, logins]) => count(logins, 'FAILURE') >= 5 && count(logins, 'SUCCESS') > 0).map(([account]) => account);

    expect(suspects).toEqual(['acct_0042']);
  });

  it('every address in the seed is from a documentation range', () => {
    for (const event of loadEvents()) {
      expect(DOCUMENTATION_RANGES.check(event.ip_address), event.ip_address).toBe(true);
    }
  });

  it('seeded accounts do not collide with injected ones', () => {
    // inject.ts attacks acct_9000..acct_9999.
    expect(loadEvents().some((e) => e.account_id.startsWith('acct_9'))).toBe(false);
  });
});

describe('rebaseEvents', () => {
  it('makes the newest event happen now', () => {
    const rebased = rebaseEvents(loadEvents(), NOW);

    expect(Math.max(...rebased.map((e) => e.event_time))).toBe(NOW.getTime());
  });

  it('keeps every gap between events', () => {
    const original = loadEvents();
    const rebased = rebaseEvents(original, NOW);
    const shift = rebased[0].event_time - original[0].event_time;

    expect(shift).not.toBe(0);
    expect(rebased.every((after, i) => after.event_time - original[i].event_time === shift)).toBe(true);
    expect(rebased.every((after, i) => after.ingested_at - original[i].ingested_at === shift)).toBe(true);
  });

  it('changes nothing but the two timestamps', () => {
    const original = loadEvents();
    const rebased = rebaseEvents(original, NOW);
    const stable = ({ event_time: _eventTime, ingested_at: _ingestedAt, ...rest }: LoginEvent) => rest;

    expect(rebased.map(stable)).toEqual(original.map(stable));
    expect(original).toEqual(loadEvents()); // the input is not modified
  });
});

/** A Kafka admin client that knows one topic, or none, or cannot reach its broker. */
function fakeAdmin({ offsets = [{ low: '0', high: '246' }], unreachable = false }: { offsets?: Array<{ low: string; high: string }> | null; unreachable?: boolean } = {}) {
  const admin = {
    disconnected: false,
    async connect() {
      // What kafkajs says when nothing listens on the port.
      if (unreachable) throw new Error('Connection error: connect ECONNREFUSED 127.0.0.1:29092');
    },
    listTopics: async () => (offsets ? [TOPIC] : []),
    fetchTopicOffsets: async () => offsets ?? [],
    async disconnect() {
      admin.disconnected = true;
    },
  };
  return admin;
}

describe('countExisting', () => {
  it('counts what the topic already holds', async () => {
    const admin = fakeAdmin();

    expect(await countExisting(admin, TOPIC)).toBe(246);
    expect(admin.disconnected).toBe(true);
  });

  it('a missing topic stops the seed and points at Lab 0', async () => {
    const admin = fakeAdmin({ offsets: null });

    const failure = await countExisting(admin, TOPIC).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(SeedError);
    expect((failure as Error).message).toContain('does not exist yet');
    expect((failure as Error).message).toContain('Lab 0');
    expect(admin.disconnected).toBe(true);
  });

  it('an unreachable broker stops the seed with the reason and a next step', async () => {
    const admin = fakeAdmin({ unreachable: true });

    const failure = await countExisting(admin, TOPIC).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(SeedError);
    expect((failure as Error).message).toContain('ECONNREFUSED 127.0.0.1:29092');
    expect((failure as Error).message).toContain('npm run doctor');
    expect(admin.disconnected).toBe(true);
  });
});

describe('eventsInTopic', () => {
  it('an empty topic counts no events', () => {
    expect(eventsInTopic([{ low: '0', high: '0' }])).toBe(0);
  });

  it('events are counted across partitions from their watermarks', () => {
    // kafkajs reports offsets as strings.
    expect(
      eventsInTopic([
        { low: '0', high: '246' },
        { low: '10', high: '17' },
      ]),
    ).toBe(253);
  });
});
