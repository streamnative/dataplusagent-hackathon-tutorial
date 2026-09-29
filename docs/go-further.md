# Go further

You finished the hello world: live data flows from Kafka through streaming SQL
into an agent that can act, with a human in the loop. Here is where to take it
during the build session. Items marked **ask onsite** depend on features whose
availability in your environment an onsite StreamNative engineer can confirm.

## Build ideas

- **Richer context.** Join the other preloaded topics (`identity_changes`,
  `threat_intel`, `device_signals`, `payment_events`) into one materialized view
  that scores each account. The agent's context stays fresh with no extra code.
- **Your own data.** Generate a live stream for your idea with ShadowTraffic
  (covered after the tutorial), register an Avro schema for your topic, and point
  the same pattern at it.
- **Decisions as events.** Instead of a SQL table, let the agent write its
  decisions to a Kafka topic that other systems consume. The StreamNative MCP
  server offers `kafka_client_produce` on a cluster route. **Ask onsite.**
- **Event-driven agents.** Start a session automatically for every alert instead
  of when you type: Agent Engine triggers can open one session per Kafka event.
  **Ask onsite.**

## Agent Engine features to reach for

### Custom tools: your code as a tool

Custom tools run in *your* process, so they can call any API you have
credentials for (post to Slack, open a ticket, call your service). Declare one in
the agent's `tools`:

```json
{
  "type": "custom",
  "name": "notify_oncall",
  "description": "Page the on-call analyst about an account. Returns a ticket id.",
  "input_schema": {
    "type": "object",
    "properties": { "account_id": { "type": "string" }, "summary": { "type": "string" } },
    "required": ["account_id", "summary"]
  }
}
```

When the agent calls it, the session emits `agent.custom_tool_use` and goes idle
with `stop_reason.type = "requires_action"`. Run your code, then answer with:

```json
{
  "type": "user.custom_tool_result",
  "custom_tool_use_id": "<the agent.custom_tool_use event id>",
  "content": [{ "type": "text", "text": "ticket OPS-123 opened" }]
}
```

The turn loops in this repo (`run_turn` / `runTurn`) answer approvals for MCP
tools; extend them with a branch for `agent.custom_tool_use` that calls your
function and sends this event. Answer every blocked id, or the session waits
forever.

### Permission policies

`always_allow` runs a tool immediately; `always_ask` pauses the session for a
human, as in L4. Keep write tools on `always_ask` until you trust them, and keep
tools you don't need disabled (see `default_config.enabled: false` in
[`agent/l4-act.json`](../agent/l4-act.json)).

### Skills and guardrails

Skills package instructions and reference files (a `SKILL.md` bundle) the agent
reads on demand, for example an investigation playbook. Guardrails cap tool
calls or cost per session. See the Orca documentation for both.

### Other clients

Orca implements the Managed Agents API, so clients built for that API can talk
to your Agent Engine by changing their base URL. **Ask onsite** before relying on
it: authentication details differ between clients.

## What makes a strong demo

- **It runs live**, on the real stack, in front of the judges.
- **It needs both halves**: real-time data *and* an agent. If a nightly batch job
  would do, the streaming half isn't pulling its weight.
- **It teaches something** about the problem, the data, or the tools.
- **Someone else could run it** from your README.
- **It tells a story** in five minutes: the problem, the moment it's solved, the payoff.
