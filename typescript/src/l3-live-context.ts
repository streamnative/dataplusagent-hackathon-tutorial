/**
 * L3 - Agent + live context.
 *
 * Upgrades your agent with read-only SQL tools from an MCP server and opens a
 * conversation. Ask, run `npm run inject` in a second terminal, then ask again:
 * the answer changes.
 *
 *     npm run l3
 */

import {
  agentParams,
  chat,
  ensureAgent,
  ensureEnvironment,
  loadConfig,
  loadLayer,
  mcpVaultIds,
  openSession,
  orcaClient,
  runMain,
  stateFor,
} from './common.js';

const QUESTION = 'Which accounts look like an account takeover right now?';

async function main(): Promise<void> {
  const config = loadConfig(['ORCA_BASE_URL', 'ORCA_MODEL']);
  const client = orcaClient(config);
  const state = stateFor(config);
  const environmentId = await ensureEnvironment(client, state, `hello-env-${config.participant}`);

  // The same agent, next version: agent/<stack>/l3-live-context.json adds the MCP server.
  const layer = loadLayer('l3-live-context', config.stack);
  const agent = await ensureAgent(client, state, agentParams(layer, config));
  console.log(`${agent.name} v${agent.version}: ${layer.summary}`);

  // StreamNative Cloud's MCP server needs a credential. It goes in a vault, never
  // in the prompt. The MCP server on your laptop takes none, so there is no vault.
  const vaultIds = await mcpVaultIds(client, state, config);

  const session = await openSession(client, state, environmentId, agent, 'L3: live context', { vaultIds });
  console.log('Tip: after the first answer, run `npm run inject` in another terminal and ask again.\n');
  await chat(client, session.id, QUESTION, { sendFirst: config.stack === 'local' });
}

await runMain(main);
