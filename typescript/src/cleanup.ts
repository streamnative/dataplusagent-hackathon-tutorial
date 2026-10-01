/**
 * Remove the agent, vault, and environment your scripts created.
 *
 *     npm run cleanup
 *
 * Your SQL objects stay; drop them with sql/99_reset.sql.
 */

import { cleanup, loadConfig, orcaClient, runMain, stateFor } from './common.js';

async function main(): Promise<void> {
  const config = loadConfig(['ORCA_BASE_URL']);
  await cleanup(orcaClient(config), stateFor(config));
}

await runMain(main);
