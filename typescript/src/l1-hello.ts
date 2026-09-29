/**
 * L1 - Hello, agent.
 *
 * Creates your agent (no tools yet), starts a session, and says hello.
 *
 *     npm run l1                           # asks a default question
 *     npm run l1 -- "your own question"
 */

import { agentParams, ensureAgent, ensureEnvironment, loadConfig, loadLayer, orcaClient, runMain, runTurn, stateFor } from './common.js';

const QUESTION = 'Hi! What is the Data + Agent Hackathon, and what can you see right now?';

async function main(): Promise<void> {
  const config = loadConfig(['ORCA_BASE_URL', 'SN_API_KEY', 'ORCA_MODEL']);
  const client = orcaClient(config);
  const state = stateFor(config);

  // 1. An environment: where your agent's sessions run.
  const environmentId = await ensureEnvironment(client, state, `hello-env-${config.participant}`);

  // 2. An agent: a model plus a system prompt, from agent/l1-hello.json.
  const layer = loadLayer('l1-hello');
  const agent = await ensureAgent(client, state, agentParams(layer, config));
  console.log(`${agent.name} v${agent.version}: ${layer.summary}`);

  // 3. A session: one conversation, pinned to this exact agent version.
  const session = await client.sessions.create({
    environment_id: environmentId,
    agent: { type: 'agent', id: agent.id, version: agent.version },
    title: 'L1: hello',
  });

  // 4. Send a message and stream the agent's reply.
  const question = process.argv.slice(2).join(' ') || QUESTION;
  console.log(`[you]    ${question}`);
  await runTurn(client, session.id, question);
}

await runMain(main);
