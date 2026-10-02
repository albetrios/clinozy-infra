import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as logger from '@setup/common/logger.js';
import { targetRoot } from '@setup/common/paths.js';
import type { SetupConfig } from '@setup/common/types.js';

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
  /** If set, run this to verify CLI login. Skipped when tokenEnvKey is set and present in env. */
  authCheck?: string;
  /** When set and this env var is non-empty (e.g. from .setup/.setup-credentials), treat as authenticated (API/token-based; no login). */
  tokenEnvKey?: string;
}

const PREREQUISITES: PrerequisiteCheck[] = [
  {
    name: 'Node.js',
    command: 'node',
    versionFlag: '--version',
    required: true,
  },
  {
    name: 'pnpm',
    command: 'pnpm',
    versionFlag: '--version',
    required: true,
  },
  // No AWS CLI entry: the AWS provider talks to S3/IAM through @aws-sdk only and never shells out,
  // so requiring the `aws` binary blocked whole runs on a tool nothing invokes.
  {
    name: 'GitHub CLI',
    command: 'gh',
    versionFlag: '--version',
    required: false,
    providerKeys: ['github', 'github-app-with-oauth'],
    enabledCheck: (config) => config.providers.github.enabled,
    authCheck: 'gh auth status',
    tokenEnvKey: 'GITHUB_TOKEN',
  },
  {
    name: 'Railway CLI',
    command: 'railway',
    versionFlag: '--version',
    required: false,
    providerKeys: ['railway', 'railway-redis'],
    enabledCheck: (config) => config.providers.railway.enabled,
    authCheck: 'railway whoami',
    tokenEnvKey: 'RAILWAY_API_TOKEN',
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

/**
 * True when `version` (e.g. `24.13.0`) meets a `>=X[.Y[.Z]]` engines range. Any other range shape
 * is treated as satisfied — this is an early warning, not a semver implementation.
 */
export function satisfiesMinimumNode(range: string, version: string): boolean {
  const minimum = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range);
  if (!minimum) return true;
  const want = [minimum[1], minimum[2], minimum[3]].map((part) => Number(part ?? 0));
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

/** Providers that run the backend repo's own scripts (docs; bootstrap migrations), which enforce its `engines.node`. */
const TARGET_SCRIPT_PROVIDERS = ['postman', 'scalar', 'neon'];

/**
 * The backend's `pnpm docs:*` scripts refuse a Node older than its `engines.node`, which failed
 * Postman and Scalar mid-run on the first clinozy provisioning. Check it before anything is created.
 */
function checkTargetNodeVersion(selectedProviderKeys?: ReadonlySet<string>): boolean {
  if (
    selectedProviderKeys &&
    !TARGET_SCRIPT_PROVIDERS.some((key) => selectedProviderKeys.has(key))
  ) {
    return true;
  }
  let range: string | undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(targetRoot(), 'package.json'), 'utf-8')) as {
      engines?: { node?: string };
    };
    range = manifest.engines?.node;
  } catch {
    return true; // no readable target manifest — the providers report their own errors
  }
  if (!range) return true;
  if (satisfiesMinimumNode(range, process.versions.node)) {
    logger.success(`Node.js for the target repo — v${process.versions.node} (needs ${range})`);
    return true;
  }
  logger.error(
    `Node.js v${process.versions.node} is older than the target repo requires (${range}) — its docs scripts (Postman, Scalar) will refuse to run. Switch Node first (e.g. \`nvm use 24\`).`,
  );
  return false;
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

export function checkPrerequisites(
  config: SetupConfig,
  selectedProviderKeys?: ReadonlySet<string>,
): boolean {
  logger.info('Checking prerequisites...');
  logger.blank();

  let allPassed = true;

  for (const prerequisite of PREREQUISITES) {
    // Honor `--providers`/`-r` scope: skip a CLI whose providers are all outside the selection, so
    // a Neon-only run isn't blocked by a missing AWS/Railway CLI it will never invoke.
    if (
      prerequisite.providerKeys &&
      selectedProviderKeys &&
      !prerequisite.providerKeys.some((key) => selectedProviderKeys.has(key))
    ) {
      logger.info(`${prerequisite.name} — skipped (not in selected providers)`);
      continue;
    }

    if (prerequisite.enabledCheck && !prerequisite.enabledCheck(config)) {
      logger.info(`${prerequisite.name} — skipped (provider disabled)`);
      continue;
    }

    const version = commandExists(prerequisite.command, prerequisite.versionFlag);

    if (version === null) {
      if (prerequisite.required) {
        logger.error(`${prerequisite.name} — NOT FOUND (required)`);
        allPassed = false;
      } else {
        logger.warn(`${prerequisite.name} — NOT FOUND (needed for ${prerequisite.name} provider)`);
        allPassed = false;
      }
      continue;
    }

    logger.success(`${prerequisite.name} — ${version}`);

    if (prerequisite.authCheck || prerequisite.tokenEnvKey) {
      const tokenValue = prerequisite.tokenEnvKey
        ? (process.env[prerequisite.tokenEnvKey] ?? '').trim()
        : '';
      const hasToken = tokenValue.length > 0;
      if (hasToken) {
        logger.success(`  └─ authenticated (${prerequisite.tokenEnvKey} from env)`);
      } else if (prerequisite.authCheck && isAuthenticated(prerequisite.authCheck)) {
        logger.success(`  └─ authenticated`);
      } else {
        const hint = prerequisite.tokenEnvKey
          ? `set ${prerequisite.tokenEnvKey} in .setup/.setup-credentials or run: ${prerequisite.authCheck?.split(' ').slice(0, 2).join(' ') ?? ''} login`
          : `run: ${prerequisite.authCheck?.split(' ').slice(0, 2).join(' ')} login`;
        logger.warn(`  └─ NOT authenticated — ${hint}`);
        allPassed = false;
      }
    }
  }

  if (!checkTargetNodeVersion(selectedProviderKeys)) allPassed = false;

  logger.blank();

  if (!allPassed) {
    logger.error('Some prerequisites are missing. Install them before running setup.');
  }

  return allPassed;
}
