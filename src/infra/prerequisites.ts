/**
 * Prerequisites — checked in order at the start of every `pnpm setup:infra` run, and on their own by
 * `pnpm setup:infra:prereqs`:
 *   1. Tools        Node and pnpm (≥ the strictest minimum of all three repos; differing pins
 *                   are flagged), and the CLIs the selected providers use
 *   2. Logins       GitHub and Railway (token in .setup-credentials, or the CLI's login — a missing
 *                   token is asked for once), Netlify (CLI login only)
 *   3. Config       setup.config.json passes `doctor`, both app repos are found, backend deps installed
 *   4. Credentials  what each selected provider needs from .setup-credentials (missing ones are
 *                   asked for next by the credentials guide)
 * Steps 1–3 must pass before anything is provisioned; step 4 only reports.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontendRepository, getEnvironmentNames } from '@setup/common/config.js';
import * as logger from '@setup/common/logger.js';
import { frontendRootIfExists, targetRoot, toolPath } from '@setup/common/paths.js';
import {
  NETLIFY_LOGIN_COMMAND,
  credentialUrl,
  getEnvSetupValue,
  reloadSecrets,
} from '@setup/common/secrets.js';
import type { SetupConfig } from '@setup/common/types.js';
import { isNonInteractiveRun } from '@setup/envs/env-file-setup.util.js';
import { ghTry } from '@setup/github/gh.js';
import { runDoctorChecks } from '@setup/infra/doctor.js';
import { askForValue, credentialStatus } from '@setup/infra/guide.js';
import { PRESETS } from '@setup/presets/index.js';

interface PrerequisiteCheck {
  name: string;
  command: string;
  versionFlag: string;
  required: boolean;
  enabledCheck?: (config: SetupConfig) => boolean;
  /**
   * Provider key(s) this CLI serves. When the run is scoped (`--providers`/`-r`), a prerequisite
   * whose providers are ALL outside the selection is skipped — a Neon-only run must not fail because
   * the AWS or Railway CLI is absent. Prerequisites with no providerKeys (Node, pnpm) are universal
   * and always checked.
   */
  providerKeys?: string[];
}

// Node and pnpm are not listed here: `checkRuntimeVersions` checks them against every repo's engines.
const PREREQUISITES: PrerequisiteCheck[] = [
  // No AWS CLI entry: the AWS provider talks to S3/IAM through @aws-sdk only and never shells out,
  // so requiring the `aws` binary blocked whole runs on a tool nothing invokes.
  {
    name: 'GitHub CLI',
    command: 'gh',
    versionFlag: '--version',
    required: false,
    providerKeys: ['github', 'github-app-with-oauth'],
    enabledCheck: (config) => config.providers.github.enabled,
  },
  {
    name: 'Railway CLI',
    command: 'railway',
    versionFlag: '--version',
    required: false,
    providerKeys: ['railway', 'railway-redis'],
    enabledCheck: (config) => config.providers.railway.enabled,
  },
];

function commandExists(command: string, versionFlag: string): string | null {
  try {
    const output = execSync(`${command} ${versionFlag}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return output.trim().split('\n')[0] ?? output.trim();
  } catch {
    return null;
  }
}

/** `[major, minor, patch]` of a `>=X[.Y[.Z]]` engines range, or undefined for any other shape. */
function minimumOf(range: string): number[] | undefined {
  const minimum = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range);
  return minimum
    ? [minimum[1], minimum[2], minimum[3]].map((part) => Number(part ?? 0))
    : undefined;
}

/** The range with the highest `>=` minimum (ranges of any other shape are ignored). */
export function strictestMinimum(ranges: readonly string[]): string | undefined {
  let best: { range: string; minimum: number[] } | undefined;
  for (const range of ranges) {
    const minimum = minimumOf(range);
    if (!minimum) continue;
    const higher =
      !best ||
      minimum.some((part, index) => {
        const earlier = minimum.slice(0, index).every((p, i) => p === best?.minimum[i]);
        return earlier && part > (best?.minimum[index] ?? 0);
      });
    if (higher) best = { range, minimum };
  }
  return best?.range;
}

/**
 * True when `version` (e.g. `24.13.0`) meets a `>=X[.Y[.Z]]` engines range. Any other range shape
 * is treated as satisfied — this is an early warning, not a semver implementation.
 */
export function satisfiesMinimumVersion(range: string, version: string): boolean {
  const want = minimumOf(range);
  if (!want) return true;
  const have = version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const difference = (have[index] ?? 0) - (want[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** Providers that run the backend repo's own scripts (docs), which need its dependencies installed. */
const TARGET_SCRIPT_PROVIDERS = ['postman', 'scalar'];

interface RepoVersions {
  name: string;
  nodeMinimum?: string;
  pnpmMinimum?: string;
  /** `packageManager` pnpm version (`pnpm@11.1.1+sha…` → `11.1.1`). */
  pnpmPin?: string;
  /** `.nvmrc` — what CI and Docker install. */
  nodePin?: string;
}

/** What clinozy-infra, the backend and the frontend each declare for Node and pnpm. */
function repoVersions(): RepoVersions[] {
  const roots: { name: string; root: string | undefined }[] = [
    { name: 'clinozy-infra', root: toolPath() },
    {
      name: 'backend',
      root: (() => {
        try {
          return targetRoot();
        } catch {
          return undefined;
        }
      })(),
    },
    { name: 'frontend', root: frontendRootIfExists() },
  ];
  return roots.flatMap(({ name, root }) => {
    if (!root || !existsSync(join(root, 'package.json'))) return [];
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
        name?: string;
        engines?: { node?: string; pnpm?: string };
        packageManager?: string;
      };
      const nvmrc = join(root, '.nvmrc');
      return [
        {
          name: manifest.name ?? name,
          ...(manifest.engines?.node ? { nodeMinimum: manifest.engines.node } : {}),
          ...(manifest.engines?.pnpm ? { pnpmMinimum: manifest.engines.pnpm } : {}),
          ...(manifest.packageManager?.startsWith('pnpm@')
            ? { pnpmPin: manifest.packageManager.slice(5).split('+')[0] }
            : {}),
          ...(existsSync(nvmrc) ? { nodePin: readFileSync(nvmrc, 'utf-8').trim() } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
}

/** Warn when the repos declare different values for one version field. */
function warnIfOutOfSync(repos: RepoVersions[], field: keyof RepoVersions, label: string): void {
  const declared = repos.filter((repo) => repo[field]);
  if (new Set(declared.map((repo) => repo[field])).size <= 1) return;
  logger.warn(
    `${label} differs across repos: ${declared.map((repo) => `${repo.name} ${repo[field]}`).join(' · ')}`,
  );
}

/**
 * Node and pnpm must meet the strictest minimum any of the three repos declares (setup runs the
 * backend's scripts and writes both apps' files), and their pins should agree.
 */
function checkRuntimeVersions(): boolean {
  const repos = repoVersions();
  let passed = true;
  const check = (tool: string, installed: string | null, field: 'nodeMinimum' | 'pnpmMinimum') => {
    const required = strictestMinimum(repos.flatMap((repo) => (repo[field] ? [repo[field]] : [])));
    if (installed === null) {
      logger.error(`${tool} — not found (install it, then run setup again)`);
      passed = false;
    } else if (required && !satisfiesMinimumVersion(required, installed)) {
      logger.error(
        `${tool} — v${installed.replace(/^v/, '')} is older than required (${required})`,
      );
      passed = false;
    } else {
      logger.success(
        `${tool} — v${installed.replace(/^v/, '')}${required ? ` (needs ${required})` : ''}`,
      );
    }
  };
  check('Node.js', process.versions.node, 'nodeMinimum');
  check('pnpm', commandExists('pnpm', '--version'), 'pnpmMinimum');
  warnIfOutOfSync(repos, 'nodeMinimum', 'Node minimum (engines.node)');
  warnIfOutOfSync(repos, 'nodePin', 'Node version (.nvmrc)');
  warnIfOutOfSync(repos, 'pnpmMinimum', 'pnpm minimum (engines.pnpm)');
  warnIfOutOfSync(repos, 'pnpmPin', 'pnpm version (packageManager)');
  return passed;
}

function isAuthenticated(authCommand: string): boolean {
  try {
    execSync(authCommand, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

interface LoginCheck {
  name: string;
  providerKeys: string[];
  enabledCheck: (config: SetupConfig) => boolean;
  /** The `.setup-credentials` token that stands in for a CLI login (asked for once when missing). */
  tokenKey?: string;
  tokenLabel?: string;
  /** The CLI's own login check, used when there is no token. */
  cliCheck?: string;
  /** How to log in when neither is there. */
  fix: string;
}

const LOGINS: LoginCheck[] = [
  {
    name: 'GitHub',
    providerKeys: ['github', 'github-app-with-oauth'],
    enabledCheck: (config) => config.providers.github.enabled,
    tokenKey: 'GITHUB_TOKEN',
    tokenLabel: 'token with repo + environment-secrets access',
    cliCheck: 'gh auth status',
    fix: 'add GITHUB_TOKEN to .setup/.setup-credentials, or run `gh auth login`',
  },
  {
    name: 'Railway',
    providerKeys: ['railway', 'railway-redis'],
    enabledCheck: (config) => config.providers.railway.enabled,
    tokenKey: 'RAILWAY_API_TOKEN',
    tokenLabel: 'account token',
    cliCheck: 'railway whoami',
    fix: 'add RAILWAY_API_TOKEN to .setup/.setup-credentials, or run `railway login`',
  },
  {
    name: 'Netlify',
    providerKeys: ['netlify'],
    enabledCheck: (config) => config.providers.netlify?.enabled === true,
    fix: `run \`${NETLIFY_LOGIN_COMMAND}\` (opens the browser) — Netlify is used through this login only`,
  },
];

/**
 * The GitHub provider creates GitHub Environments in both app repos, which needs more than read
 * access. Returns what is wrong, or undefined when the current login can list them in each repo.
 */
function githubEnvironmentAccessProblem(config: SetupConfig): string | undefined {
  const repositories = [config.providers.github.repository, frontendRepository(config)].filter(
    (repository): repository is string => Boolean(repository),
  );
  const denied = repositories.filter(
    (repository) =>
      ghTry(['api', `repos/${repository}/environments`], { timeoutMs: 15_000 }).status !== 0,
  );
  if (denied.length === 0) return undefined;
  return (
    `it cannot manage GitHub Environments in ${denied.join(', ')} — give the token Administration + ` +
    'Environments (read & write) and Secrets (read) on both app repos (https://github.com/settings/tokens)'
  );
}

function section(step: number, title: string): void {
  logger.blank();
  logger.info(`Prerequisites ${step}/4 — ${title}`);
}

const inScope = (keys: readonly string[], selected?: ReadonlySet<string>): boolean =>
  !selected || keys.some((key) => selected.has(key));

/** Step 2: how each login is satisfied; asks once for a missing token when interactive. */
async function checkLogins(config: SetupConfig, selected?: ReadonlySet<string>): Promise<boolean> {
  let passed = true;
  for (const login of LOGINS) {
    if (!login.enabledCheck(config) || !inScope(login.providerKeys, selected)) continue;
    const hasToken = () => Boolean(login.tokenKey && getEnvSetupValue(login.tokenKey));
    let via: string | undefined;
    if (hasToken()) via = `${login.tokenKey} in .setup-credentials`;
    else if (login.cliCheck && isAuthenticated(login.cliCheck)) via = `${login.name} CLI login`;
    else if (!login.tokenKey && reloadSecrets(config).netlify?.authToken) via = 'Netlify CLI login';
    if (!via && login.tokenKey && !isNonInteractiveRun()) {
      logger.info(`  ${login.name} — ${credentialUrl(login.tokenKey) ?? ''}`);
      if (await askForValue(login.tokenKey, login.tokenLabel ?? 'token')) {
        via = `${login.tokenKey} in .setup-credentials`;
      }
    }
    const problem =
      via && login.name === 'GitHub' && inScope(['github'], selected)
        ? githubEnvironmentAccessProblem(config)
        : undefined;
    if (via && problem) {
      logger.error(`${login.name} — ${via}, but ${problem}`);
      passed = false;
    } else if (via) {
      logger.success(`${login.name} — ${via}`);
    } else {
      logger.error(`${login.name} — not logged in: ${login.fix}`);
      passed = false;
    }
  }
  return passed;
}

/** Step 3: setup.config.json (via `doctor`), the app repos, and the backend's dependencies. */
function checkConfig(config: SetupConfig, selected?: ReadonlySet<string>): boolean {
  let passed = true;
  const environments = getEnvironmentNames(config);
  logger.success(
    `setup.config.json — ${config.project.name} · ${config.frontend?.name ?? 'no frontend'} · domain ${config.product?.domain ?? '(none)'} · ${environments.join(', ')}`,
  );
  for (const diagnostic of runDoctorChecks(config, PRESETS)) {
    if (diagnostic.level === 'error') {
      logger.error(diagnostic.message);
      passed = false;
    } else {
      logger.warn(diagnostic.message);
    }
  }
  let backend: string | undefined;
  try {
    backend = targetRoot();
    logger.success(`Backend repo — ${backend}`);
  } catch (error) {
    logger.error(
      `Backend repo — ${error instanceof Error ? error.message : String(error)} (set CLINOZY_BE_DIR or target.path)`,
    );
    passed = false;
  }
  if (backend && TARGET_SCRIPT_PROVIDERS.some((key) => inScope([key], selected))) {
    if (existsSync(join(backend, 'node_modules'))) {
      logger.success('Backend dependencies — installed');
    } else {
      logger.error(`Backend dependencies — missing: run \`pnpm install\` in ${backend}`);
      passed = false;
    }
  }
  const frontend = frontendRootIfExists();
  if (frontend) logger.success(`Frontend repo — ${frontend}`);
  else
    logger.warn(
      'Frontend repo — not found; its env files will be skipped (set CLINOZY_FE_DIR or frontend.path)',
    );
  return passed;
}

/** Step 4: report what `.setup-credentials` still lacks (the credentials guide asks next). */
function reportCredentials(config: SetupConfig, selected?: ReadonlySet<string>): void {
  const statuses = credentialStatus(config, getEnvironmentNames(config), selected);
  const complete = statuses.filter((status) => status.missing.length === 0);
  if (complete.length > 0) {
    logger.success(`Set — ${complete.map((status) => status.label).join(', ')}`);
  }
  const incomplete = statuses.filter((status) => status.missing.length > 0);
  for (const status of incomplete) {
    logger.warn(`${status.label} — missing ${status.missing.join(', ')} (${status.url})`);
  }
  if (incomplete.length > 0) {
    logger.info(
      isNonInteractiveRun()
        ? '  Run setup in a terminal without --yes to be asked for these.'
        : '  You will be asked for these next.',
    );
  }
}

export async function checkPrerequisites(
  config: SetupConfig,
  selectedProviderKeys?: ReadonlySet<string>,
): Promise<boolean> {
  let allPassed = true;

  section(1, 'Tools');
  if (!checkRuntimeVersions()) allPassed = false;
  for (const prerequisite of PREREQUISITES) {
    // Honor `--providers`/`-r` scope: skip a CLI whose providers are all outside the selection, so
    // a Neon-only run isn't blocked by a missing AWS/Railway CLI it will never invoke.
    if (prerequisite.providerKeys && !inScope(prerequisite.providerKeys, selectedProviderKeys)) {
      continue;
    }
    if (prerequisite.enabledCheck && !prerequisite.enabledCheck(config)) continue;
    const version = commandExists(prerequisite.command, prerequisite.versionFlag);
    if (version === null) {
      logger.error(`${prerequisite.name} — not found (install it, then run setup again)`);
      allPassed = false;
      continue;
    }
    logger.success(`${prerequisite.name} — ${version}`);
  }

  section(2, 'Logins');
  if (!(await checkLogins(config, selectedProviderKeys))) allPassed = false;

  section(3, 'Config');
  if (!checkConfig(config, selectedProviderKeys)) allPassed = false;

  section(4, 'Credentials (.setup/.setup-credentials)');
  reportCredentials(config, selectedProviderKeys);

  logger.blank();
  if (allPassed) {
    logger.success('Prerequisites — all set.');
  } else {
    logger.error('Prerequisites — fix the items marked above, then run setup again.');
  }
  return allPassed;
}

/** CLI entry (`pnpm setup:infra:prereqs`): the same checks, no provisioning. Exits 1 on a failure. */
export async function runPrerequisitesCheck(config: SetupConfig): Promise<void> {
  if (!(await checkPrerequisites(config))) process.exitCode = 1;
}
