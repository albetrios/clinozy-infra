/**
 * CLI entry for `pnpm setup:github:status` — per-environment GitHub status dashboard.
 *
 * Full sync / check / dry-run live in `sync.ts` and are invoked via `pnpm setup:github[:*]`.
 */
import { fileURLToPath } from 'node:url';
import * as logger from '@setup/common/logger.js';
import { loadConfig } from '@setup/common/config.js';
import { buildGitHubStatus, printGitHubStatus } from './status.js';

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const environments = config.environments.map((e) => ({ name: e.name, branch: e.deployBranch }));
    const statuses = buildGitHubStatus(config.providers.github.repository, environments);
    printGitHubStatus(statuses);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
