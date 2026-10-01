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
  ensureVault,
  loadConfig,
  loadLayer,
  orcaClient,
  runMain,
  stateFor,
} from './common.js';

const REQUEST = 'Flag the account most likely to be under attack right now.';

async function main(): Promise<void> {
  const config = loadConfig(['ORCA_BASE_URL', 'ORCA_MODEL', 'SN_MCP_URL']);
  const client = orcaClient(config);
  const state = stateFor(config);
  const environmentId = await ensureEnvironment(client, state, `hello-env-${config.participant}`);

  // Next version again: agent/l4-act.json enables one write tool, always_ask.
  const layer = loadLayer('l4-act');
  const agent = await ensureAgent(client, state, agentParams(layer, config));
  console.log(`${agent.name} v${agent.version}: ${layer.summary}`);

  const vaultId = await ensureVault(client, state, `hello-vault-${config.participant}`, config);
  const session = await client.sessions.create({
    environment_id: environmentId,
    agent: { type: 'agent', id: agent.id, version: agent.version },
    vault_ids: [vaultId],
    title: 'L4: act with approval',
  });

  // askHuman is called whenever the session pauses for approval.
  await chat(client, session.id, REQUEST, { confirm: (toolUse) => askHuman(toolUse) });
}

await runMain(main);
