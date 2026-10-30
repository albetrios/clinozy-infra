import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { targetRoot } from '@setup/common/paths.js';
import { resolve } from 'node:path';
import { loadConfig, getEnvironmentNames } from '@setup/common/config.js';
import type { SetupConfig } from '@setup/common/types.js';

// Lazy path getters — the target repo is resolved on first use (after config sets
// target.path), not at module import, so `target.path` is honored and importing this
// module doesn't throw when clinozy-be is absent.
const environmentExamplePath = (): string => resolve(targetRoot(), '.env.example');
const githubEnvironmentsDirectory = (): string => resolve(targetRoot(), '.github/environments');
const githubRulesetsDirectory = (): string => resolve(targetRoot(), '.github/rulesets');
const deployWorkflowPath = (): string =>
  resolve(targetRoot(), '.github/workflows/reusable-railway-deploy.yml');

export interface GitHubSyncScaffoldResult {
  readonly createdEnvironmentFiles: string[];
  readonly createdGithubEnvironmentConfigs: string[];
  readonly createdRulesets: string[];
}

export interface GitHubSyncConsistencyIssue {
  readonly dimension: string;
  readonly detail: string;
}

interface SyncEnvironment {
  name: string;
  branch: string;
}

const TOP_BANNER_LINE = /^#\s=+\s*$/;
const HALF_BANNER_LINE = /^#\s#{3,}\s*$/;
const NODE_ENV_LINE = /^NODE_ENV=.*$/m;

function environmentsFromConfig(config: SetupConfig): SyncEnvironment[] {
  return config.environments.map((e) => ({ name: e.name, branch: e.deployBranch }));
}

function listGithubEnvironmentConfigs(): string[] {
  const entries = readdirSync(githubEnvironmentsDirectory(), { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith('.json'))) continue;
    const content = readFileSync(resolve(githubEnvironmentsDirectory(), entry.name), 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      names.push(String((parsed as { name: unknown }).name));
    }
  }
  return names.sort();
}

/**
 * The environments reusable-railway-deploy.yml can deploy. Single-trunk: `main` deploys to every
 * environment (development on merge, production on release), so the workflow never derives the
 * environment from the branch. The caller names it (`github_environment`, or the dispatch
 * `target`) and the resolve step allowlists it:
 *
 *   development|production) echo "environment=$environment" >> "$GITHUB_OUTPUT" ;;
 *
 * Returns undefined when the workflow is missing or has no such allowlist.
 */
function parseWorkflowEnvironmentAllowlist(): string[] | undefined {
  if (!existsSync(deployWorkflowPath())) return undefined;
  const source = readFileSync(deployWorkflowPath(), 'utf-8');
  const match = source.match(
    /^\s*([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*)\)\s*echo\s+"environment=\$environment"/m,
  );
  return match?.[1]?.split('|').sort();
}

export function validateGithubSyncConsistency(config: SetupConfig): GitHubSyncConsistencyIssue[] {
  const syncEnvironments = environmentsFromConfig(config);
  const configuredEnvironmentNames = new Set(syncEnvironments.map((e) => e.name));
  const configuredBranches = new Set(syncEnvironments.map((e) => e.branch));
  const githubEnvs = new Set(listGithubEnvironmentConfigs());
  const workflowEnvironments = parseWorkflowEnvironmentAllowlist();
  const issues: GitHubSyncConsistencyIssue[] = [];

  for (const branch of configuredBranches) {
    if (!existsSync(resolve(githubRulesetsDirectory(), `${branch}.json`))) {
      issues.push({
        dimension: 'setup.config.json ↔ rulesets',
        detail: `Configured branch "${branch}" has no .github/rulesets/${branch}.json.`,
      });
    }
  }

  for (const env of githubEnvs) {
    if (!configuredEnvironmentNames.has(env)) {
      issues.push({
        dimension: '.github/environments ↔ setup.config.json',
        detail: `GitHub environment "${env}" is not listed in setup.config.json.`,
      });
    }
  }

  for (const env of configuredEnvironmentNames) {
    if (!githubEnvs.has(env)) {
      issues.push({
        dimension: 'setup.config.json ↔ GitHub envs',
        detail: `Configured environment "${env}" has no .github/environments/${env}.json.`,
      });
    }
  }

  if (workflowEnvironments === undefined) {
    issues.push({
      dimension: 'reusable-railway-deploy.yml ↔ setup.config.json',
      detail:
        'reusable-railway-deploy.yml has no deploy environment allowlist (`<env>|<env>) echo "environment=$environment"`).',
    });
  } else {
    for (const env of workflowEnvironments) {
      if (!configuredEnvironmentNames.has(env)) {
        issues.push({
          dimension: 'reusable-railway-deploy.yml ↔ setup.config.json',
          detail: `Workflow deploys environment "${env}", which is not listed in setup.config.json.`,
        });
      }
    }
    for (const env of configuredEnvironmentNames) {
      if (!workflowEnvironments.includes(env)) {
        issues.push({
          dimension: 'setup.config.json ↔ reusable-railway-deploy.yml',
          detail: `Configured environment "${env}" is not in the deploy allowlist of reusable-railway-deploy.yml.`,
        });
      }
    }
  }

  return issues;
}

export function printGithubSyncConsistencyReport(config: SetupConfig): void {
  const syncEnvironments = environmentsFromConfig(config);
  const githubEnvs = listGithubEnvironmentConfigs();
  const workflowEnvironments = parseWorkflowEnvironmentAllowlist();

  console.log('Environment consistency');
  console.log('----------------------');
  console.log(
    `Sync config:      ${syncEnvironments.map((e) => `${e.name} (branch ${e.branch})`).join(', ')}`,
  );
  console.log(`GitHub envs:      ${githubEnvs.join(', ')}`);
  console.log(`Workflow envs:    ${workflowEnvironments?.join(', ') ?? '(no allowlist found)'}`);
  console.log('');
}

export function getGithubSyncEnvironmentNames(config?: SetupConfig): string[] {
  return getEnvironmentNames(config ?? loadConfig()).sort();
}

/** Each deploy branch once — single-trunk environments share `main`. */
export function getGithubSyncBranches(config?: SetupConfig): string[] {
  const cfg = config ?? loadConfig();
  return [...new Set(cfg.environments.map((e) => e.deployBranch))].sort();
}

function buildEnvironmentFile(environment: string, exampleContent: string): string {
  const lines = exampleContent.split('\n');
  const bodyStartIndex = lines.findIndex((line) => HALF_BANNER_LINE.test(line));
  if (bodyStartIndex === -1) {
    throw new Error('Cannot find a `# ###...###` half banner in .env.example.');
  }

  const introBlock = lines.slice(0, bodyStartIndex);
  const equalsBanners = introBlock.filter((line) => TOP_BANNER_LINE.test(line)).length;
  if (equalsBanners === 0) {
    throw new Error('No `# ===...===` banner found before the first half banner in .env.example.');
  }

  const environmentHeader = [
    '# =============================================================================',
    `# Environment file for "${environment}"`,
    '# =============================================================================',
    '#',
    '# This file mirrors .env.example with descriptions preserved.',
    '# Fill required values before syncing to GitHub.',
    '#',
    `# Push with: pnpm setup:github`,
    '#',
    '# =============================================================================',
    '',
  ];

  const body = lines.slice(bodyStartIndex);
  return [...environmentHeader, ...body]
    .join('\n')
    .replace(NODE_ENV_LINE, `NODE_ENV=${environment}`);
}

function buildGithubEnvironmentConfig(environment: string): string {
  return `${JSON.stringify({ name: environment, protection: {} }, null, 2)}\n`;
}

function buildBranchRuleset(branch: string): string {
  const ruleset = {
    name: `Protect ${branch}`,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: [`refs/heads/${branch}`] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          allowed_merge_methods: ['squash', 'merge'],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 1,
          required_review_thread_resolution: true,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [
            { context: 'PR CI / Lint' },
            { context: 'PR CI / Typecheck' },
            { context: 'PR CI / Static sync' },
            { context: 'PR CI / Unit + global (pull_request)' },
            { context: 'PR CI / Migration lint' },
            { context: 'PR CI / Build verify' },
            { context: 'PR CI / Security audit' },
            { context: 'PR CI / Security secrets' },
            { context: 'PR CI / Security SAST' },
            { context: 'PR CI / Contract + property' },
            { context: 'PR Governance / Checks' },
          ],
        },
      },
    ],
  };
  return `${JSON.stringify(ruleset, null, 2)}\n`;
}

function writeIfMissing(filePath: string, contents: string): boolean {
  if (existsSync(filePath)) {
    return false;
  }
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  writeFileSync(filePath, contents, 'utf-8');
  return true;
}

function scaffoldGithubSyncEnvironment(
  env: SyncEnvironment,
  exampleContent: string,
): GitHubSyncScaffoldResult {
  const result: GitHubSyncScaffoldResult = {
    createdEnvironmentFiles: [],
    createdGithubEnvironmentConfigs: [],
    createdRulesets: [],
  };

  const envFilePath = resolve(targetRoot(), `.env.${env.name}`);
  if (writeIfMissing(envFilePath, buildEnvironmentFile(env.name, exampleContent))) {
    result.createdEnvironmentFiles.push(`.env.${env.name}`);
  }

  const githubEnvPath = resolve(targetRoot(), `.github/environments/${env.name}.json`);
  if (writeIfMissing(githubEnvPath, buildGithubEnvironmentConfig(env.name))) {
    result.createdGithubEnvironmentConfigs.push(`.github/environments/${env.name}.json`);
  }

  const rulesetPath = resolve(targetRoot(), `.github/rulesets/${env.branch}.json`);
  if (writeIfMissing(rulesetPath, buildBranchRuleset(env.branch))) {
    result.createdRulesets.push(`.github/rulesets/${env.branch}.json`);
  }

  return result;
}

export function scaffoldGithubSyncFiles(config?: SetupConfig): GitHubSyncScaffoldResult {
  const cfg = config ?? loadConfig();
  if (!existsSync(environmentExamplePath())) {
    throw new Error('Cannot find .env.example at the repo root.');
  }

  const syncEnvironments = environmentsFromConfig(cfg);
  const exampleContent = readFileSync(environmentExamplePath(), 'utf-8');
  const result: GitHubSyncScaffoldResult = {
    createdEnvironmentFiles: [],
    createdGithubEnvironmentConfigs: [],
    createdRulesets: [],
  };

  for (const env of syncEnvironments) {
    const single = scaffoldGithubSyncEnvironment(env, exampleContent);
    result.createdEnvironmentFiles.push(...single.createdEnvironmentFiles);
    result.createdGithubEnvironmentConfigs.push(...single.createdGithubEnvironmentConfigs);
    result.createdRulesets.push(...single.createdRulesets);
  }

  return result;
}
