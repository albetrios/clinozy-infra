/**
 * One-step GitHub bootstrap.
 *
 * Runs — in order — to bring a fresh repository (or fresh deploy target) up to
 * the committed source-of-truth state. Idempotent: safe to re-run.
 *
 *   1. gh auth preflight (show active user, allow switch).
 *   2. Ensure target branches exist (derived from .github/rulesets/*.json
 *      `conditions.ref_name.include` entries of the form `refs/heads/<branch>`).
 *   3. Sync rulesets (POST new ones, PUT existing by name).
 *   4. Ensure each GitHub Environment from .github/environments/*.json exists
 *      (idempotent PUT with no protection updates — protection drift is
 *      surfaced separately by `pnpm validate:github-environments`).
 *
 * Does NOT push variables or secrets. Use `pnpm github:sync` for that.
 *
 * Usage:
 *   Invoked by `pnpm github:sync` (and `github:sync --check` / `--dry-run`).
 *   Do not run this file directly — use `pnpm github:sync`.
 *
 * Modes:
 *   default      — write changes to the remote.
 *   --check      — read-only drift report; exit non-zero if anything is missing.
 *   --dry-run    — show what would be created or updated without writing.
 *
 * Plan note: repository rulesets require GitHub Pro / Team / Enterprise on
 * private repos. Branch + environment creation works on every plan. So on the
 * free personal plan this script creates branches and environments, then fails
 * at the rulesets step with the upstream "Upgrade to GitHub Pro …" message.
 */

import { loadConfig } from '@setup/common/config.js';
import { runGhAuthPreflight } from './auth-preflight.js';
import { ghTry } from './gh.js';
import {
  getGithubSyncBranches,
  getGithubSyncEnvironmentNames,
  scaffoldGithubSyncFiles,
} from './sync-config.js';
import {
  getRepositoryIdentifier,
  loadLocalRulesets,
  syncRulesets,
  type SyncMode,
} from './rulesets.js';

interface DefaultBranch {
  readonly name: string;
  readonly sha: string;
}

interface RepoSummary {
  readonly default_branch?: string;
}

interface RefObject {
  readonly object?: { readonly sha?: string };
}

interface GhProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function ghProbe(args: readonly string[]): GhProbeResult {
  // No shell — every arg (including interpolated repo/branch/env paths) is passed literally.
  const result = ghTry([...args], { timeoutMs: 30_000 });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ghWriteWithBody(args: readonly string[], body: string): void {
  const result = ghTry([...args], { input: body, timeoutMs: 30_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'gh command failed');
  }
}

function getDefaultBranch(repository: string): DefaultBranch {
  const repoProbe = ghProbe(['api', `repos/${repository}`]);
  if (repoProbe.exitCode !== 0) {
    throw new Error(
      `Failed to read repository metadata for ${repository}: ${repoProbe.stderr || repoProbe.stdout || `exit ${repoProbe.exitCode}`}`,
    );
  }
  const repoSummary = JSON.parse(repoProbe.stdout) as RepoSummary;
  const branchName = repoSummary.default_branch;
  if (!branchName) {
    throw new Error(`Repository ${repository} has no default_branch in API response.`);
  }

  const refProbe = ghProbe(['api', `repos/${repository}/git/refs/heads/${branchName}`]);
  if (refProbe.exitCode !== 0) {
    throw new Error(
      `Failed to read SHA for default branch "${branchName}" on ${repository}: ${refProbe.stderr || refProbe.stdout || `exit ${refProbe.exitCode}`}`,
    );
  }
  const ref = JSON.parse(refProbe.stdout) as RefObject;
  const sha = ref.object?.sha;
  if (!sha) {
    throw new Error(`Default branch "${branchName}" has no SHA in API response.`);
  }

  return { name: branchName, sha };
}

function branchExists(repository: string, branch: string): boolean {
  const probe = ghProbe(['api', `repos/${repository}/branches/${branch}`]);
  if (probe.exitCode === 0) return true;
  if (/HTTP\s+404/i.test(probe.stderr) || /HTTP\s+404/i.test(probe.stdout)) return false;
  throw new Error(
    `Failed to probe branch "${branch}" on ${repository}: ${probe.stderr || probe.stdout || `exit ${probe.exitCode}`}`,
  );
}

function environmentExists(repository: string, environment: string): boolean {
  const probe = ghProbe(['api', `repos/${repository}/environments/${environment}`]);
  if (probe.exitCode === 0) return true;
  if (/HTTP\s+404/i.test(probe.stderr) || /HTTP\s+404/i.test(probe.stdout)) return false;
  throw new Error(
    `Failed to probe environment "${environment}" on ${repository}: ${probe.stderr || probe.stdout || `exit ${probe.exitCode}`}`,
  );
}

function createBranchFromSha(repository: string, branch: string, sha: string): void {
  ghWriteWithBody(
    [
      'api',
      '--method',
      'POST',
      '-H',
      'Accept: application/vnd.github+json',
      `repos/${repository}/git/refs`,
      '--input',
      '-',
    ],
    JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  );
}

function createOrUpdateEnvironment(repository: string, environment: string): void {
  ghWriteWithBody(
    [
      'api',
      '--method',
      'PUT',
      '-H',
      'Accept: application/vnd.github+json',
      `repos/${repository}/environments/${environment}`,
      '--input',
      '-',
    ],
    '{}',
  );
}

interface EnsureResult {
  readonly failures: number;
  readonly drift: number;
}

/** The GitHub calls {@link ensureGithubEnvironment} makes — injectable for tests. */
export interface GithubEnvironmentApi {
  exists(repository: string, environment: string): boolean;
  create(repository: string, environment: string): void;
}

const githubEnvironmentApi: GithubEnvironmentApi = {
  exists: environmentExists,
  create: createOrUpdateEnvironment,
};

/**
 * Make sure one GitHub Environment exists: an existing one is left untouched (protection rules are
 * the app's own `.github/environments/*.json`, checked by `validate:github-environments`); a missing
 * one is created empty for the app's `github:sync` to fill.
 */
export function ensureGithubEnvironment(
  repository: string,
  environment: string,
  api: GithubEnvironmentApi = githubEnvironmentApi,
): 'present' | 'created' {
  if (api.exists(repository, environment)) return 'present';
  api.create(repository, environment);
  return 'created';
}

function ensureBranches(args: {
  readonly repository: string;
  readonly branches: readonly string[];
  readonly mode: SyncMode;
}): EnsureResult {
  const { repository, branches, mode } = args;

  if (branches.length === 0) {
    console.log('  (no literal `refs/heads/<branch>` targets found in committed rulesets)');
    return { failures: 0, drift: 0 };
  }

  let defaultBranchCache: DefaultBranch | undefined;
  function loadDefaultBranchOnce(): DefaultBranch {
    defaultBranchCache ??= getDefaultBranch(repository);
    return defaultBranchCache;
  }

  let failures = 0;
  let drift = 0;

  for (const branch of branches) {
    try {
      const exists = branchExists(repository, branch);

      if (exists) {
        console.log(`  ${branch}: already present`);
        continue;
      }

      if (mode === 'check') {
        console.error(`  ${branch}: missing on remote`);
        drift += 1;
        continue;
      }

      const source = loadDefaultBranchOnce();
      if (branch === source.name) {
        console.log(`  ${branch}: already present (default branch)`);
        continue;
      }

      if (mode === 'dry-run') {
        console.log(`  ${branch}: would create from ${source.name} (${source.sha.slice(0, 7)})`);
        continue;
      }

      createBranchFromSha(repository, branch, source.sha);
      console.log(`  ${branch}: created from ${source.name}`);
    } catch (ensureError) {
      failures += 1;
      const message = ensureError instanceof Error ? ensureError.message : String(ensureError);
      console.error(`  ${branch}: FAILED`);
      console.error(`    ${message.replace(/\n/g, '\n    ')}`);
    }
  }

  return { failures, drift };
}

function ensureEnvironments(args: {
  readonly repository: string;
  readonly environments: readonly string[];
  readonly mode: SyncMode;
}): EnsureResult {
  const { repository, environments, mode } = args;

  if (environments.length === 0) {
    console.log('  (no .github/environments/*.json files found)');
    return { failures: 0, drift: 0 };
  }

  let failures = 0;
  let drift = 0;

  for (const environment of environments) {
    try {
      const exists = githubEnvironmentApi.exists(repository, environment);

      if (exists) {
        console.log(`  ${environment}: already present`);
        continue;
      }

      if (mode === 'check') {
        console.error(`  ${environment}: missing on remote`);
        drift += 1;
        continue;
      }

      if (mode === 'dry-run') {
        console.log(`  ${environment}: would create`);
        continue;
      }

      ensureGithubEnvironment(repository, environment);
      console.log(`  ${environment}: created`);
    } catch (ensureError) {
      failures += 1;
      const message = ensureError instanceof Error ? ensureError.message : String(ensureError);
      console.error(`  ${environment}: FAILED`);
      console.error(`    ${message.replace(/\n/g, '\n    ')}`);
    }
  }

  return { failures, drift };
}

export interface RunGithubInitResult {
  readonly failures: number;
  readonly drift: number;
}

/**
 * Run the init pipeline. Exported so `tooling/setup/github/sync.ts` can compose
 * it without spawning a subprocess.
 */
export async function runGithubInit(args: {
  readonly mode: SyncMode;
  readonly purpose?: string;
  /** Skip gh auth preflight (e.g. setup:infra with GITHUB_TOKEN only). */
  readonly skipPreflight?: boolean;
  /** When true, scaffold local IaC on sync mode (default). github/sync.ts passes false — it scaffolds first. */
  readonly scaffoldOnSync?: boolean;
  /**
   * Restrict the sync to these environment names (setup:infra runs this once per environment, so
   * each pass syncs only that environment's branch + ruleset + GitHub Environment). Omit for the
   * whole repository (`pnpm github:sync`).
   */
  readonly environmentNames?: readonly string[];
}): Promise<RunGithubInitResult> {
  const config = loadConfig();
  const scaffoldOnSync = args.scaffoldOnSync ?? true;
  if (args.mode === 'sync' && scaffoldOnSync) {
    scaffoldGithubSyncFiles(config);
  }

  const repository = getRepositoryIdentifier();
  const allLocals = loadLocalRulesets();
  const allBranches = getGithubSyncBranches(config);
  const allEnvironments = getGithubSyncEnvironmentNames(config);

  // Per-environment scope: narrow branches / rulesets / GitHub Environments to the requested
  // environment(s). Each environment names its deploy branch (`config.environments[].deployBranch`)
  // and that branch's committed ruleset `<branch>.json`. Single-trunk environments share `main`, so
  // each per-environment pass re-checks it (idempotent).
  const scopeEnvironments = args.environmentNames;
  const scopedBranches = new Set(
    (scopeEnvironments
      ? config.environments.filter((environment) => scopeEnvironments.includes(environment.name))
      : config.environments
    ).map((environment) => environment.deployBranch),
  );
  const branches = scopeEnvironments
    ? allBranches.filter((branch) => scopedBranches.has(branch))
    : allBranches;
  const environments = scopeEnvironments
    ? allEnvironments.filter((environment) => scopeEnvironments.includes(environment))
    : allEnvironments;
  const locals = scopeEnvironments
    ? allLocals.filter((local) => scopedBranches.has(local.fileName.replace(/\.json$/, '')))
    : allLocals;

  console.log(`Repository:    ${repository}`);
  console.log(`Mode:          ${args.mode}`);
  console.log('Config:        tooling/setup/setup.config.json');
  console.log(`Rulesets:      ${locals.map((local) => local.fileName).join(', ')}`);
  console.log(`Branches:      ${branches.length > 0 ? branches.join(', ') : '(none derived)'}`);
  console.log(`Environments:  ${environments.length > 0 ? environments.join(', ') : '(none)'}`);
  console.log('');

  if (!args.skipPreflight) {
    await runGhAuthPreflight({
      repository,
      purpose: args.purpose ?? 'Initialise GitHub branches, rulesets, and environments',
      destructive: args.mode === 'sync',
    });
  }

  console.log('Step 1/3 — Ensuring target branches exist');
  const branchResult = ensureBranches({ repository, branches, mode: args.mode });

  console.log('');
  console.log('Step 2/3 — Syncing rulesets');
  const rulesetResult = syncRulesets({ repository, locals, mode: args.mode });

  console.log('');
  console.log('Step 3/3 — Ensuring GitHub Environments exist');
  const environmentResult = ensureEnvironments({ repository, environments, mode: args.mode });

  return {
    failures: branchResult.failures + rulesetResult.failures + environmentResult.failures,
    drift: branchResult.drift + rulesetResult.drift + environmentResult.drift,
  };
}
