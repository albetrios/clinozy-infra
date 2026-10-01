/**
 * Push AUDIT_RETENTION_DAYS and AUTH_SESSION_RETENTION_DAYS to GitHub Environment secrets.
 * Requires: gh auth login (or GH_TOKEN with repo + secrets scope).
 *
 * Usage:
 *   pnpm setup:push-retention-secrets
 *   CONFIG=development pnpm setup:push-retention-secrets
 *   AUDIT_RETENTION_DAYS=90 AUTH_SESSION_RETENTION_DAYS=30 pnpm setup:push-retention-secrets
 */
import { execSync, spawnSync } from 'node:child_process';
import { toolPath } from '@setup/common/paths.js';
import { existsSync, readFileSync } from 'node:fs';

const CONFIG_PATH = toolPath('setup.config.json');

/**
 * Maps short CLI aliases (`dev`, `prod`) to canonical full GitHub Environment
 * names (`development`, `production`). Always use full names downstream — the
 * `gh secret set --env <name>` calls and the `.github/environments/*.json`
 * files are keyed by the canonical name.
 */
const GITHUB_ENV_MAP: Record<string, string> = {
  dev: 'development',
  development: 'development',
  prod: 'production',
  production: 'production',
};

/**
 * NAMING — single source of truth = `tooling/setup/setup.config.json`.
 * The set of ENVIRONMENT NAMES is read from `environments[].name`; the
 * ORGANIZATION + PROJECT NAMES come from `project.organization` / `project.name`
 * (and `providers.github.repository`). Never hardcode these — the config is the
 * one place that must be correct.
 */
function loadConfigJson(): {
  project?: { name?: string; organization?: string };
  environments?: Array<{ name?: string }>;
  providers?: { github?: { repository?: string } };
} | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadEnvironmentNames(): string[] {
  const names = loadConfigJson()
    ?.environments?.map((environment) => environment.name)
    .filter((name): name is string => Boolean(name));
  return names && names.length > 0 ? names : ['development', 'production'];
}

function loadRepository(): string {
  const repository = loadConfigJson()?.providers?.github?.repository;
  if (repository) return repository;

  return execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

function setGitHubEnvironmentSecret(
  repository: string,
  environment: string,
  secretName: string,
  secretValue: string,
): void {
  const result = spawnSync(
    'gh',
    [
      'secret',
      'set',
      secretName,
      '--repo',
      repository,
      '--env',
      environment,
      '--body',
      secretValue,
    ],
    { encoding: 'utf-8', timeout: 15000 },
  );
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? 'unknown error';
    throw new Error(`Failed to set ${secretName} for environment "${environment}": ${stderr}`);
  }
}

function main(): void {
  const auditRetentionDays = process.env.AUDIT_RETENTION_DAYS ?? '90';
  const sessionRetentionDays = process.env.AUTH_SESSION_RETENTION_DAYS ?? '30';
  const configFilter = process.env.CONFIG;

  let repository: string;
  try {
    repository = loadRepository();
  } catch (loadError) {
    const message = loadError instanceof Error ? loadError.message : String(loadError);
    console.error(`Could not resolve GitHub repository: ${message}`);
    console.error(
      'Run gh auth login or set providers.github.repository in tooling/setup/setup.config.json',
    );
    process.exit(1);
  }

  const environments: string[] = configFilter
    ? [GITHUB_ENV_MAP[configFilter] ?? configFilter]
    : loadEnvironmentNames();

  const secrets = [
    { name: 'AUDIT_RETENTION_DAYS', value: auditRetentionDays },
    { name: 'AUTH_SESSION_RETENTION_DAYS', value: sessionRetentionDays },
  ] as const;

  console.log(`Repository: ${repository}`);
  console.log(`Environments: ${environments.join(', ')}`);
  console.log('');

  for (const environment of environments) {
    for (const secret of secrets) {
      console.log(`Setting ${secret.name} (env: ${environment})...`);
      setGitHubEnvironmentSecret(repository, environment, secret.name, secret.value);
      console.log(`  OK`);
    }
  }

  console.log('');
  console.log('Done. Verify with: pnpm validate:github-env');
}

main();
