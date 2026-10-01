/**
 * Full GitHub sync — single entry point for local IaC + remote state + env values.
 *
 * Order:
 *   1. Consistency check (config ↔ rulesets ↔ workflow ↔ GitHub env JSON).
 *   2. Scaffold missing local files from tooling/setup/setup.config.json (sync mode only).
 *   3. Remote init (branches → rulesets → GitHub Environment shells).
 *   4. Reconcile .env.<environment> → GitHub Environments (sync mode only):
 *        - Push all secrets and variables from each local file.
 *        - Delete any secret or variable on GitHub NOT in the local file.
 *
 * Modes:
 *   default    — all environments: scaffold + remote apply + full reconcile.
 *   <env>      — single environment reconcile.
 *   --check    — consistency + read-only remote drift; no writes.
 *   --dry-run  — consistency + preview remote and values; no writes.
 *   --yes      — skip values confirmation (automation).
 *
 * Usage:
 *   pnpm github:sync                  # reconcile ALL configured environments
 *   pnpm github:sync production       # reconcile a single environment
 *   pnpm github:sync --check
 *   pnpm github:sync --dry-run
 *   pnpm github:sync --yes
 *
 * Adding or removing a hosted environment: edit tooling/setup/setup.config.json, NODE_ENV,
 * reusable-railway-deploy.yml, and related IaC by hand — then run setup:github. There is no
 * env:add / env:remove / branch:add script.
 */

import { existsSync } from 'node:fs';
import { targetRoot } from '@setup/common/paths.js';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '@setup/common/config.js';
import type { SetupConfig } from '@setup/common/types.js';
import { runGithubInit } from './init.js';
import {
  printGithubSyncConsistencyReport,
  scaffoldGithubSyncFiles,
  validateGithubSyncConsistency,
  type GitHubSyncScaffoldResult,
} from './sync-config.js';
import { syncEnvironmentToGitHub } from './sync-github-environments.js';
import { ghTry } from './gh.js';
import type { SyncMode } from './rulesets.js';

interface CliOptions {
  readonly checkOnly: boolean;
  readonly dryRun: boolean;
  readonly skipConfirmation: boolean;
  readonly prune: boolean;
  readonly environments: string[];
}

function parseArguments(): CliOptions {
  const argumentsList = process.argv.slice(2);
  const environments: string[] = [];

  if (argumentsList.includes('--help') || argumentsList.includes('-h')) {
    console.log('Usage: pnpm github:sync [environment...] [--check | --dry-run] [--yes] [--prune]');
    console.log('');
    console.log('  (default)   All environments: scaffold + remote apply + full reconcile');
    console.log('  environment Optional environment name(s), e.g. production');
    console.log('  --check     Read-only consistency + remote drift (no writes)');
    console.log('  --dry-run   Preview remote and values push (no writes)');
    console.log('  --yes       Skip the values-push confirmation prompt');
    console.log('  --prune     Delete remote environments not in setup.config.json');
    process.exit(0);
  }

  const allowed = new Set(['--check', '--dry-run', '--yes', '-y', '--prune']);
  for (const argument of argumentsList) {
    if (allowed.has(argument)) continue;
    if (argument.startsWith('--')) {
      throw new Error(`Unknown argument "${argument}". Use --help for options.`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(argument)) {
      throw new Error(`Invalid environment "${argument}". Use lowercase letters, digits, dashes.`);
    }
    environments.push(argument);
  }

  if (argumentsList.includes('--check') && argumentsList.includes('--dry-run')) {
    throw new Error('Use either --check or --dry-run, not both.');
  }

  return {
    checkOnly: argumentsList.includes('--check'),
    dryRun: argumentsList.includes('--dry-run'),
    skipConfirmation: argumentsList.includes('--yes') || argumentsList.includes('-y'),
    prune: argumentsList.includes('--prune'),
    environments,
  };
}

/**
 * Prune remote GitHub environments and rulesets that are not in the config.
 * Asks for confirmation before removing anything.
 */
async function pruneStaleEnvironments(config: SetupConfig): Promise<void> {
  const repository = config.providers.github.repository;
  const configEnvNames = new Set(config.environments.map((e) => e.name));

  // List remote environments (no shell — repository is a single argv element).
  const listResult = ghTry(
    ['api', `repos/${repository}/environments`, '--jq', '.environments[].name'],
    {
      timeoutMs: 15_000,
    },
  );
  if (listResult.status !== 0) {
    console.log('  Could not list remote environments — skipping prune.');
    return;
  }
  const remoteEnvs = listResult.stdout.trim().split('\n').filter(Boolean);

  const staleEnvs = remoteEnvs.filter((e) => !configEnvNames.has(e));
  if (staleEnvs.length === 0) {
    console.log('No stale environments to prune.');
    return;
  }

  console.log('');
  console.log(`  Stale environments on remote (not in config): ${staleEnvs.join(', ')}`);
  console.log('  Rulesets for branches not in config will also be flagged.');
  console.log('');

  if (!isInteractiveShell()) {
    console.log('  Non-interactive shell — skipping prune. Re-run with --yes for automation.');
    return;
  }

  const { default: readlineModule } = await import('node:readline/promises');
  const rl = readlineModule.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  Remove these environments? Type "prune" to confirm: `);
  rl.close();

  if (answer.trim() !== 'prune') {
    console.log('  Prune aborted.');
    return;
  }

  for (const env of staleEnvs) {
    const deleteResult = ghTry(
      ['api', '--method', 'DELETE', `repos/${repository}/environments/${env}`],
      { timeoutMs: 10_000 },
    );
    if (deleteResult.status === 0) {
      console.log(`  ✓ Removed environment: ${env}`);
    } else {
      console.error(
        `  ✗ Failed to remove ${env}: ${deleteResult.stderr.trim() || `exit ${deleteResult.status}`}`,
      );
    }
  }

  console.log('');
}

function detectLocalEnvironmentFiles(
  requestedEnvironments: readonly string[],
  config: SetupConfig,
): Array<{ environment: string; filePath: string }> {
  const environmentNames =
    requestedEnvironments.length > 0
      ? requestedEnvironments
      : config.environments.map((e) => e.name);
  const validEnvironmentNames = new Set(config.environments.map((e) => e.name));
  const found: Array<{ environment: string; filePath: string }> = [];
  for (const environment of environmentNames) {
    if (!validEnvironmentNames.has(environment)) {
      throw new Error(
        `${environment} is not listed in setup.config.json. Edit the config file first.`,
      );
    }
    const filePath = resolve(targetRoot(), `.env.${environment}`);
    if (existsSync(filePath)) {
      found.push({ environment, filePath });
    } else if (requestedEnvironments.length > 0) {
      throw new Error(
        `Missing .env.${environment} at the repo root. Run \`pnpm setup:infra:export-env\` to create it from .env.example.`,
      );
    } else {
      console.log(`  Skipping "${environment}" — no .env.${environment} file found.`);
    }
  }
  return found;
}

function printScaffoldResult(scaffoldResult: GitHubSyncScaffoldResult): void {
  const created = [
    ...scaffoldResult.createdEnvironmentFiles,
    ...scaffoldResult.createdGithubEnvironmentConfigs,
    ...scaffoldResult.createdRulesets,
  ];
  if (created.length === 0) {
    console.log('Local GitHub sync files: already present.');
    console.log('');
    return;
  }
  console.log('Local GitHub sync files scaffolded:');
  for (const filePath of created) {
    console.log(`  + ${filePath}`);
  }
  console.log('');
}

async function askExactPhrase(question: string, expected: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(question);
    return answer.trim() === expected;
  } finally {
    readline.close();
  }
}

function isInteractiveShell(): boolean {
  if (process.env.CI === 'true' || process.env.CI === '1') return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function main(): Promise<void> {
  const { checkOnly, dryRun, skipConfirmation, prune, environments } = parseArguments();
  const mode: SyncMode = checkOnly ? 'check' : dryRun ? 'dry-run' : 'sync';
  const config = loadConfig();

  console.log('Sync config: tooling/setup/setup.config.json');
  console.log(
    `Configured environments: ${config.environments
      .map((e) => `${e.name}:${e.deployBranch}`)
      .join(', ')}`,
  );
  console.log('');

  printGithubSyncConsistencyReport(config);
  const consistencyIssues = validateGithubSyncConsistency(config);
  if (consistencyIssues.length > 0) {
    console.error('Environment consistency check failed:');
    for (const issue of consistencyIssues) {
      console.error(`  [${issue.dimension}] ${issue.detail}`);
    }
    console.error('');
    console.error('Fix tooling/setup/setup.config.json and related IaC, then re-run setup:github.');
    process.exit(1);
  }
  console.log('Environment consistency: OK');
  console.log('');

  const scaffoldResult =
    checkOnly || dryRun
      ? { createdEnvironmentFiles: [], createdGithubEnvironmentConfigs: [], createdRulesets: [] }
      : scaffoldGithubSyncFiles(config);
  printScaffoldResult(scaffoldResult);

  const initResult = await runGithubInit({
    mode,
    purpose: checkOnly
      ? 'Read-only check: branches + rulesets + environments'
      : 'GitHub sync: branches + rulesets + environments + values',
    scaffoldOnSync: false,
  });

  console.log('');

  if (initResult.failures > 0) {
    console.error(`Remote sync failed with ${initResult.failures} failure(s).`);
    process.exit(1);
  }

  if (checkOnly) {
    if (initResult.drift === 0) {
      console.log('Check complete — consistency OK and no remote drift.');
    } else {
      console.error(`Drift detected: ${initResult.drift} item(s) missing on remote.`);
      console.error('Run `pnpm github:sync` to apply.');
      process.exit(1);
    }
    process.exit(0);
  }

  // Prune stale environments/rulesets not in config
  if (prune && !dryRun) {
    await pruneStaleEnvironments(config);
  }

  const localFiles = detectLocalEnvironmentFiles(environments, config);
  if (localFiles.length === 0) {
    console.log('No local .env.<environment> files found.');
    console.log(
      'Edit tooling/setup/setup.config.json if needed, then run `pnpm setup:github` again.',
    );
    process.exit(0);
  }

  console.log('Reconciling environments (push + delete stale)');
  for (const entry of localFiles) {
    console.log(`  .env.${entry.environment}  → GitHub Environment "${entry.environment}"`);
  }
  console.log('');

  if (!dryRun) {
    if (skipConfirmation) {
      console.log('  --yes supplied — skipping confirmation prompt.');
      console.log('');
    } else if (!isInteractiveShell()) {
      console.error('Non-interactive shell: re-run with --yes to push values.');
      process.exit(1);
    } else {
      console.log('  ! This reconciles GitHub Environments against local .env.<env> files.');
      console.log('  ! Items in the local files are pushed; items on GitHub NOT in the');
      console.log('  ! local files are DELETED. The local file is the source of truth.');
      console.log('  ! Type "sync" to proceed (anything else aborts).');
      console.log('');
      const confirmed = await askExactPhrase('  Confirm: ', 'sync');
      if (!confirmed) {
        console.log('Aborted — no values were pushed.');
        process.exit(130);
      }
      console.log('');
    }
  }

  process.env.GITHUB_SYNC_PARENT = '1';

  let valueFailures = 0;
  let totalPushed = 0;
  let totalSkipped = 0;
  let totalDeleted = 0;

  for (const entry of localFiles) {
    console.log(`--- ${entry.environment} ---`);
    try {
      const result = await syncEnvironmentToGitHub({
        environment: entry.environment,
        dryRun,
        skipPreflight: true,
      });
      totalPushed += result.pushed;
      totalSkipped += result.skipped;
      totalDeleted += result.deleted;
    } catch (error) {
      valueFailures += 1;
      console.error(`Sync for "${entry.environment}" failed.`);
      console.error(error instanceof Error ? error.message : String(error));
    }
    console.log('');
  }

  if (valueFailures > 0) {
    console.error(`Sync finished with ${valueFailures} environment(s) failed.`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('Dry run complete. No changes pushed.');
    process.exit(0);
  }

  console.log(
    `Sync complete — pushed ${totalPushed}, skipped ${totalSkipped}, deleted ${totalDeleted} across ${localFiles.length} environment(s).`,
  );
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
