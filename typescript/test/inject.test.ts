/** buildBurst: the brute-force-then-success login burst `npm run inject` produces. */

import { readFileSync } from 'node:fs';

import avro from 'avsc';
import { describe, expect, it } from 'vitest';

import { buildBurst, newAccountId } from '../src/inject.js';

const SCHEMA = avro.Type.forSchema(JSON.parse(readFileSync(new URL('../../schemas/login_events.avsc', import.meta.url), 'utf8')));
const NOW = new Date(Date.UTC(2026, 9, 7, 10, 30));

const burst = () => buildBurst('acct_9123', '203.0.113.77', NOW);

describe('buildBurst', () => {
  it("every event matches the topic's Avro schema", () => {
    for (const record of burst()) {
      const problems: string[] = [];
      SCHEMA.isValid(record, { errorHook: (path) => problems.push(path.join('.')) });
      expect(problems).toEqual([]);
      expect(SCHEMA.fromBuffer(SCHEMA.toBuffer(record))).toEqual(record);
    }
  });

  it('is six failed logins, then one success', () => {
    expect(burst().map((r) => r.result)).toEqual([...Array(6).fill('FAILURE'), 'SUCCESS']);
  });

  it('comes from one account and one new IP address', () => {
    const records = burst();

    expect(new Set(records.map((r) => r.account_id))).toEqual(new Set(['acct_9123']));
    expect(new Set(records.map((r) => r.ip_address))).toEqual(new Set(['203.0.113.77']));
  });

  it('is in time order with unique ids', () => {
    const records = burst();
    const times = records.map((r) => r.event_time);

    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(records.length);
    expect(new Set(records.map((r) => r.event_id)).size).toBe(records.length);
  });

  it('only the failures carry a failure reason', () => {
    const records = burst();

    expect(records.slice(0, -1).every((r) => r.failure_reason)).toBe(true);
    expect(records.at(-1)!.failure_reason).toBeNull();
  });

  it('injected accounts do not collide with the preloaded ones', () => {
    // The preload uses acct_0001..acct_0500-ish; injected ids live in 9000-9999.
    const ids = new Set(Array.from({ length: 50 }, () => newAccountId()));

    expect([...ids].every((id) => /^acct_9\d{3}$/.test(id))).toBe(true);
    expect(ids.size).toBeGreaterThan(1);
  });

  it('uses the same epoch-millisecond timestamps as the Python path', () => {
    // 2026-10-07T10:30:00Z, then two seconds per attempt.
    expect(burst().map((r) => r.event_time)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => 1791369000000 + 2000 * i));
  });
});
