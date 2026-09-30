/**
 * L3 - Agent + live context.
 *
 * Upgrades your agent with read-only StreamNative MCP tools, gives the session a
 * vault holding the MCP credential, and opens a conversation. Ask, run
 * `npm run inject` in a second terminal, then ask again: the answer changes.
 *
 *     npm run l3
 */

import { agentParams, chat, ensureAgent, ensureEnvironment, ensureVault, loadConfig, loadLayer, orcaClient, runMain, stateFor } from './common.js';

const QUESTION = 'Which accounts look like an account takeover right now?';

async function main(): Promise<void> {
  const config = loadConfig(['ORCA_BASE_URL', 'ORCA_MODEL', 'SN_MCP_URL']);
  const client = orcaClient(config);
  const state = stateFor(config);
  const environmentId = await ensureEnvironment(client, state, `hello-env-${config.participant}`);

  // The same agent, next version: agent/l3-live-context.json adds the MCP server.
  const layer = loadLayer('l3-live-context');
  const agent = await ensureAgent(client, state, agentParams(layer, config));
  console.log(`${agent.name} v${agent.version}: ${layer.summary}`);

  // The MCP server needs a credential. It goes in a vault, never in the prompt.
  const vaultId = await ensureVault(client, state, `hello-vault-${config.participant}`, config);

  const session = await client.sessions.create({
    environment_id: environmentId,
    agent: { type: 'agent', id: agent.id, version: agent.version },
    vault_ids: [vaultId],
    title: 'L3: live context',
  });
  console.log('Tip: after the first answer, run `npm run inject` in another terminal and ask again.\n');
  await chat(client, session.id, QUESTION);
}

await runMain(main);
