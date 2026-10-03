/**
 * L4 - Agent acts, human approves.
 *
 * Lets your agent insert into flagged_accounts, but only with your approval: the
 * tool has an `always_ask` policy, so the session pauses until you decide.
 *
 *     npm run l4
 */

import {
  agentParams,
  askHuman,
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

const REQUEST = 'Flag the account most likely to be under attack right now.';

async function main(): Promise<void> {
  const config = loadConfig(['ORCA_BASE_URL', 'ORCA_MODEL']);
  const client = orcaClient(config);
  const state = stateFor(config);
  const environmentId = await ensureEnvironment(client, state, `hello-env-${config.participant}`);

  // Next version again: agent/<stack>/l4-act.json enables one write tool, always_ask.
  const layer = loadLayer('l4-act', config.stack);
  const agent = await ensureAgent(client, state, agentParams(layer, config));
  console.log(`${agent.name} v${agent.version}: ${layer.summary}`);

  const vaultIds = await mcpVaultIds(client, state, config);
  const session = await openSession(client, state, environmentId, agent, 'L4: act with approval', { vaultIds });

  // askHuman is called whenever the session pauses for approval.
  await chat(client, session.id, REQUEST, { confirm: (toolUse) => askHuman(toolUse), sendFirst: config.stack === 'local' });
}

await runMain(main);
