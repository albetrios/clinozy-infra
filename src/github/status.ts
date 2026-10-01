/**
 * Per-environment GitHub status dashboard.
 *
 * Shows a table of what's configured for each environment:
 * branches, rulesets, environments, secrets, and variables.
 */
import { ghTry } from './gh.js';

interface EnvStatus {
  environment: string;
  branch: string;
  branchExists: boolean;
  rulesetExists: boolean;
  envExists: boolean;
  secretCount: number;
  variableCount: number;
}

function ghProbeExists(path: string): boolean {
  // `path` is a single argv element — no shell interpolation.
  return ghTry(['api', path], { timeoutMs: 10_000 }).status === 0;
}

function ghCount(path: string): number {
  const result = ghTry(['api', '--paginate', path, '--jq', 'length'], { timeoutMs: 10_000 });
  if (result.status !== 0) return 0;
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

/**
 * Build status for each environment.
 */
export function buildGitHubStatus(
  repository: string,
  environments: Array<{ name: string; branch: string }>,
): EnvStatus[] {
  return environments.map((env) => ({
    environment: env.name,
    branch: env.branch,
    branchExists: ghProbeExists(`repos/${repository}/branches/${env.branch}`),
    rulesetExists: ghProbeExists(`repos/${repository}/rulesets`),
    envExists: ghProbeExists(`repos/${repository}/environments/${env.name}`),
    secretCount: ghCount(`repos/${repository}/environments/${env.name}/secrets`),
    variableCount: ghCount(`repos/${repository}/environments/${env.name}/variables`),
  }));
}

/**
 * Print a status table.
 */
export function printGitHubStatus(statuses: EnvStatus[]): void {
  console.log('');
  console.log('  GitHub Environment Status');
  console.log(`  ${'─'.repeat(70)}`);
  console.log('');
  console.log(
    '  ' +
      'Environment'.padEnd(16) +
      'Branch'.padEnd(12) +
      'Branch?'.padEnd(10) +
      'Ruleset?'.padEnd(10) +
      'Env?'.padEnd(8) +
      'Secrets'.padEnd(10) +
      'Vars',
  );
  console.log(`  ${'─'.repeat(70)}`);

  for (const s of statuses) {
    console.log(
      '  ' +
        s.environment.padEnd(16) +
        s.branch.padEnd(12) +
        (s.branchExists ? '✓' : '✗').padEnd(10) +
        (s.rulesetExists ? '✓' : '✗').padEnd(10) +
        (s.envExists ? '✓' : '✗').padEnd(8) +
        String(s.secretCount).padEnd(10) +
        String(s.variableCount),
    );
  }
  console.log('');
}
