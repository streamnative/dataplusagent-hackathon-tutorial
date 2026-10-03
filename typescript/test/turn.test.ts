/** runTurn: send one message and drive the session until the agent's turn ends. */

import { describe, expect, it } from 'vitest';

import { TurnError, runTurn } from '../src/common.js';
import { FakeSessionEvents, OrkLocalSessionEvents, clientWithEvents, type RawEvent } from './fakes.js';

const text = (t: string) => [{ type: 'text', text: t }];

function idle(stop: string, eventIds?: string[]): RawEvent {
  return {
    id: `evt_idle_${stop}`,
    type: 'session.status_idle',
    stop_reason: { type: stop, ...(eventIds ? { event_ids: eventIds } : {}) },
  };
}

const INSERT_CALL: RawEvent = {
  id: 'evt_tool_1',
  type: 'agent.mcp_tool_use',
  name: 'sql_workspace_insert_rows',
  mcp_server_name: 'streamnative',
  input: { table: 'flagged_accounts', rows: [{ account_id: 'acct_9123' }] },
};

async function drive(
  reactions: RawEvent[][],
  options: { history?: RawEvent[]; echo?: boolean; confirm?: (toolUse: Record<string, unknown>) => boolean } = {},
) {
  const events = new FakeSessionEvents(reactions, { history: options.history, echoUserEvents: options.echo });
  const lines: string[] = [];
  const result = await runTurn(clientWithEvents(events), 'sess_1', 'hi', { confirm: options.confirm, out: (l) => lines.push(l) });
  return { result, lines, events };
}

describe('runTurn', () => {
  it("returns and prints the agent's reply", async () => {
    const { result, lines } = await drive([[{ id: 'evt_a', type: 'agent.message', content: text('Hello!') }, idle('end_turn')]]);

    expect(result.text).toBe('Hello!');
    expect(lines.some((line) => line.includes('Hello!'))).toBe(true);
  });

  it('opens the stream before sending the message', async () => {
    const { events } = await drive([[idle('end_turn')]]);

    expect(events.calls[0]).toEqual(['stream', 'sess_1']);
    expect(events.calls[1]).toEqual(['send', 'sess_1', [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }] }]]);
  });

  it('ignores events replayed from earlier turns', async () => {
    const history: RawEvent[] = [
      { id: 'evt_old_msg', type: 'agent.message', content: text('old answer'), processed_at: '2026-10-07T09:59:01.000Z' },
      { id: 'evt_old_idle', type: 'session.status_idle', stop_reason: { type: 'end_turn' }, processed_at: '2026-10-07T09:59:02.000Z' },
    ];
    const reply: RawEvent[] = [{ id: 'evt_new', type: 'agent.message', content: text('new answer') }, idle('end_turn')];

    const { result, lines } = await drive([reply], { history });

    expect(result.text).toBe('new answer');
    expect(lines.some((line) => line.includes('old answer'))).toBe(false);
  });

  it('works when the stream does not echo user events', async () => {
    const { result } = await drive([[{ id: 'evt_a', type: 'agent.message', content: text('Hi') }, idle('end_turn')]], { echo: false });

    expect(result.text).toBe('Hi');
  });

  it('prints an event once even if the stream repeats it', async () => {
    const msg: RawEvent = { id: 'evt_a', type: 'agent.message', content: text('once') };

    const { lines } = await drive([[msg, msg, idle('end_turn')]]);

    expect(lines.filter((line) => line.includes('once'))).toHaveLength(1);
  });

  it('shows which tool ran and with what input', async () => {
    const query: RawEvent = {
      id: 'evt_q',
      type: 'agent.mcp_tool_use',
      name: 'sql_workspace_query',
      mcp_server_name: 'streamnative',
      input: { sql: 'SELECT * FROM login_failures' },
    };

    const { lines } = await drive([[query, idle('end_turn')]]);

    expect(lines.some((line) => line.includes('sql_workspace_query') && line.includes('SELECT * FROM login_failures'))).toBe(true);
  });

  it('approval sends allow for the blocked tool and continues', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const confirm = (toolUse: Record<string, unknown>) => {
      seen.push(toolUse);
      return true;
    };
    const reactions: RawEvent[][] = [
      [INSERT_CALL, idle('requires_action', ['evt_tool_1'])],
      [{ id: 'evt_done', type: 'agent.message', content: text('Flagged acct_9123.') }, idle('end_turn')],
    ];

    const { result, events } = await drive(reactions, { confirm });

    expect(seen.map((t) => t.name)).toEqual(['sql_workspace_insert_rows']);
    expect(events.calls[2]).toEqual(['send', 'sess_1', [{ type: 'user.tool_confirmation', tool_use_id: 'evt_tool_1', result: 'allow' }]]);
    expect(result.text).toBe('Flagged acct_9123.');
  });

  it('denial sends deny with a reason', async () => {
    const reactions: RawEvent[][] = [
      [INSERT_CALL, idle('requires_action', ['evt_tool_1'])],
      [{ id: 'evt_ack', type: 'agent.message', content: text('Understood, not flagged.') }, idle('end_turn')],
    ];

    const { events } = await drive(reactions, { confirm: () => false });

    const sent = (events.calls[2] as unknown as ['send', string, Array<Record<string, unknown>>])[2];
    expect(sent[0].type).toBe('user.tool_confirmation');
    expect(sent[0].tool_use_id).toBe('evt_tool_1');
    expect(sent[0].result).toBe('deny');
    expect(sent[0].deny_message).toBeTruthy();
  });

  it('a tool waiting for approval without an approver is an error', async () => {
    await expect(drive([[INSERT_CALL, idle('requires_action', ['evt_tool_1'])]])).rejects.toThrow(/approv/);
    await expect(drive([[INSERT_CALL, idle('requires_action', ['evt_tool_1'])]])).rejects.toBeInstanceOf(TurnError);
  });

  it('a retryable session error is reported but the turn continues', async () => {
    const retrying: RawEvent = {
      id: 'evt_err',
      type: 'session.error',
      error: { type: 'overloaded_error', message: 'model busy' },
      retry_status: { will_retry: true },
    };

    const { result, lines } = await drive([[retrying, { id: 'evt_a', type: 'agent.message', content: text('ok') }, idle('end_turn')]]);

    expect(result.text).toBe('ok');
    expect(lines.some((line) => line.includes('model busy') && line.includes('(retrying)'))).toBe(true);
  });

  it('a retry reported inside the error is marked as retrying too', async () => {
    // The shape `ork local` sends: the retry status sits inside `error`.
    const retrying: RawEvent = {
      id: 'evt_err',
      type: 'session.error',
      error: { type: 'unknown_error', message: 'server_error (status 502)', retry_status: { type: 'retrying' } },
    };

    const { lines } = await drive([[retrying, { id: 'evt_a', type: 'agent.message', content: text('ok') }, idle('end_turn')]]);

    expect(lines.some((line) => line.includes('server_error (status 502)') && line.includes('(retrying)'))).toBe(true);
  });

  it('an exhausted retry is not marked as retrying', async () => {
    const exhausted: RawEvent = {
      id: 'evt_err',
      type: 'session.error',
      error: { type: 'unknown_error', message: 'API key is invalid.', retry_status: { type: 'exhausted' } },
    };
    const events = new FakeSessionEvents([[exhausted, idle('retries_exhausted')]]);
    const lines: string[] = [];

    await expect(runTurn(clientWithEvents(events), 'sess_1', 'hi', { out: (l) => lines.push(l) })).rejects.toThrow(/API key is invalid\./);

    expect(lines.some((line) => line.includes('API key is invalid.'))).toBe(true);
    expect(lines.some((line) => line.includes('(retrying)'))).toBe(false);
  });

  it('retries exhausted raises with the last error message', async () => {
    const fatal: RawEvent = {
      id: 'evt_err',
      type: 'session.error',
      error: { type: 'invalid_request_error', message: 'model not found: nope-1' },
      retry_status: { will_retry: false },
    };

    await expect(drive([[fatal, idle('retries_exhausted')]])).rejects.toThrow(/model not found: nope-1/);
  });

  it('a stream that ends mid-turn is an error', async () => {
    await expect(drive([[{ id: 'evt_a', type: 'agent.message', content: text('partial') }]])).rejects.toThrow(/ended/);
  });

  it('shows a tool result briefly', async () => {
    const resultEvent: RawEvent = {
      id: 'evt_r',
      type: 'agent.mcp_tool_result',
      mcp_tool_use_id: 'evt_q',
      is_error: false,
      content: text('3 rows: acct_0042 failed=7'),
    };

    const { lines } = await drive([[resultEvent, idle('end_turn')]]);

    expect(lines.some((line) => line.includes('3 rows: acct_0042 failed=7'))).toBe(true);
  });

  it('a huge tool result does not flood the terminal', async () => {
    const resultEvent: RawEvent = { id: 'evt_r', type: 'agent.mcp_tool_result', is_error: false, content: text('x'.repeat(5000)) };

    const { lines } = await drive([[resultEvent, idle('end_turn')]]);

    expect(lines.every((line) => line.length < 300)).toBe(true);
  });

  it('a failed tool call is labelled as an error', async () => {
    const failed: RawEvent = { id: 'evt_r', type: 'agent.mcp_tool_result', is_error: true, content: text('permission denied') };

    const { lines } = await drive([[failed, idle('end_turn')]]);

    expect(lines.some((line) => line.includes('error') && line.includes('permission denied'))).toBe(true);
    expect(lines.some((line) => line.startsWith('[result]'))).toBe(false);
  });

  it('events without a timestamp are not dropped', async () => {
    const reply: RawEvent = { id: 'evt_a', type: 'agent.message', content: text('still here'), processed_at: null };

    const { result } = await drive([[reply, idle('end_turn')]]);

    expect(result.text).toBe('still here');
  });

  it('compares timestamps beyond millisecond precision', async () => {
    // An event from an earlier turn, a few microseconds before our message.
    const events = new FakeSessionEvents([[{ id: 'evt_new', type: 'agent.message', content: text('new') }, idle('end_turn')]], {
      history: [
        { id: 'evt_old', type: 'agent.message', content: text('old'), processed_at: '2026-10-07T10:00:01.000100Z' },
        { id: 'evt_old_idle', type: 'session.status_idle', stop_reason: { type: 'end_turn' }, processed_at: '2026-10-07T10:00:01.000200Z' },
      ],
    });
    // Our message is persisted at 10:00:01.000300Z: after both history events, within the same millisecond.
    const send = events.send.bind(events);
    events.send = async (sessionId, params) => {
      const response = await send(sessionId, params);
      for (const e of response.data ?? []) e.processed_at = '2026-10-07T10:00:01.000300Z';
      return response;
    };

    const result = await runTurn(clientWithEvents(events), 'sess_1', 'hi', { out: () => {} });

    expect(result.text).toBe('new');
  });
});

// That engine answers a stream opened on a quiet session only at its next
// keep-alive, 15 seconds later. With sendFirst the turn speaks first and then
// follows the session from its start.
describe('runTurn with sendFirst: the `ork local` engine', () => {
  async function driveLocal(reactions: RawEvent[][], options: { confirm?: (toolUse: Record<string, unknown>) => boolean } = {}) {
    const events = new OrkLocalSessionEvents(reactions);
    const lines: string[] = [];
    const result = await runTurn(clientWithEvents(events), 'sess_1', 'hi', { confirm: options.confirm, out: (l) => lines.push(l), sendFirst: true });
    return { result, lines, events };
  }

  it('sends the message, then follows the session from its start', async () => {
    const { events } = await driveLocal([[idle('end_turn')]]);

    expect(events.calls[0]).toEqual(['send', 'sess_1', [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }] }]]);
    // From the start of the session, not from the live edge: whatever the agent
    // said before the stream opened is replayed, not lost.
    expect(events.calls[1]).toEqual(['stream', 'sess_1', '0']);
  });

  it("returns and prints the agent's reply", async () => {
    const { result, lines } = await driveLocal([[{ id: 'evt_a', type: 'agent.message', content: text('Hello!') }, idle('end_turn')]]);

    expect(result.text).toBe('Hello!');
    expect(lines.some((line) => line.includes('Hello!'))).toBe(true);
  });

  it("shows only the second turn's reply on the second turn", async () => {
    const events = new OrkLocalSessionEvents([
      [{ id: 'evt_a1', type: 'agent.message', content: text('first answer') }, idle('end_turn')],
      [{ id: 'evt_a2', type: 'agent.message', content: text('second answer') }, { ...idle('end_turn'), id: 'evt_idle_2' }],
    ]);
    const client = clientWithEvents(events);
    await runTurn(client, 'sess_1', 'one', { out: () => {}, sendFirst: true });
    const lines: string[] = [];

    const result = await runTurn(client, 'sess_1', 'two', { out: (l) => lines.push(l), sendFirst: true });

    expect(result.text).toBe('second answer');
    expect(lines.some((line) => line.includes('first answer'))).toBe(false);
  });

  it('does not answer an approval that an earlier turn left open', async () => {
    const events = new OrkLocalSessionEvents([
      // The first turn stops at a request for approval, and nobody answers it.
      [{ ...INSERT_CALL, id: 'evt_old_tool' }, { ...idle('requires_action', ['evt_old_tool']), id: 'evt_old_wait' }],
      [{ id: 'evt_a', type: 'agent.message', content: text('done') }, idle('end_turn')],
    ]);
    const client = clientWithEvents(events);
    await expect(runTurn(client, 'sess_1', 'one', { out: () => {}, sendFirst: true })).rejects.toThrow(/approv/);
    const asked: unknown[] = [];

    const result = await runTurn(client, 'sess_1', 'two', {
      confirm: (toolUse) => {
        asked.push(toolUse);
        return true;
      },
      out: () => {},
      sendFirst: true,
    });

    expect(result.text).toBe('done');
    expect(asked).toEqual([]);
  });

  it('approval sends allow and continues', async () => {
    const { result, events } = await driveLocal(
      [
        [INSERT_CALL, idle('requires_action', ['evt_tool_1'])],
        [{ id: 'evt_done', type: 'agent.message', content: text('Flagged acct_9123.') }, { ...idle('end_turn'), id: 'evt_idle_2' }],
      ],
      { confirm: () => true },
    );

    expect(events.calls[2]).toEqual(['send', 'sess_1', [{ type: 'user.tool_confirmation', tool_use_id: 'evt_tool_1', result: 'allow' }]]);
    expect(result.text).toBe('Flagged acct_9123.');
  });

  it('treats a message the engine does not confirm as an error, not a hang', async () => {
    const events = new OrkLocalSessionEvents([[idle('end_turn')]]);
    events.send = async () => ({ data: [] });

    await expect(runTurn(clientWithEvents(events), 'sess_1', 'hi', { out: () => {}, sendFirst: true })).rejects.toThrow(/did not confirm/);
  });

  it('the default order also works on that engine: it only waits longer', async () => {
    const events = new OrkLocalSessionEvents([[{ id: 'evt_a', type: 'agent.message', content: text('Hello!') }, idle('end_turn')]]);

    const result = await runTurn(clientWithEvents(events), 'sess_1', 'hi', { out: () => {} });

    expect(result.text).toBe('Hello!');
    expect(events.calls.map((call) => call[0])).toEqual(['stream', 'send']);
  });
});
