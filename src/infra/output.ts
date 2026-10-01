/**
 * `pnpm setup:infra:output` — inspect resolved env outputs (secrets masked).
 *
 * No secret value is EVER printed. The default view is a masked inventory (non-secret
 * values shown, secrets `••••`). To obtain a secret value, `--copy <KEY>` puts it on the
 * system clipboard (never stdout, so it never enters the terminal / agent transcript),
 * auto-clears after a timeout, and records the reveal (key + env + timestamp, never the
 * value) to a gitignored audit log.
 *
 * For normal setup you never need this: provisioning / `setup:infra:export-env` write every
 * value straight into `.env.<environment>` — the one home for secrets.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names come
 * from `config.project.*` and environment names from `config.environments[].name`.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { toolPath } from '@setup/common/paths.js';
import { dirname } from 'node:path';
import { loadConfig, getEnvironmentNames } from '@setup/common/config.js';
import { loadSecrets } from '@setup/common/secrets.js';
import { loadState } from '@setup/common/state.js';
import { SetupError } from '@setup/common/setup-error.js';
import { resolveEnvironmentVariables } from '@setup/envs/build-env-vars.js';
import { FRONTEND_ENV_KEY_MAPPINGS, frontendEnvFileName } from '@setup/envs/frontend-env-keys.js';
import { clearClipboard, clipboardAvailable, copyToClipboard } from '@setup/common/clipboard.js';
import * as logger from '@setup/common/logger.js';

const AUDIT_LOG_PATH = toolPath('.setup', '.setup-state.audit.log');

/** Default clipboard auto-clear window (seconds) — matches the setup-guide UI. */
const DEFAULT_CLIPBOARD_CLEAR_SECONDS = 30;

/** Resolve/clamp the clipboard clear window: default 30s, min 5s, max 300s. Pure (testable). */
export function resolveClearSeconds(input?: number): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_CLIPBOARD_CLEAR_SECONDS;
  return Math.min(300, Math.max(5, Math.round(input)));
}

/** Keys whose VALUES are sensitive and must be masked / clipboard-only. */
const SENSITIVE_PATTERN = /(SECRET|TOKEN|PASSWORD|DSN|PRIVATE|KEY|ENCRYPTION)/i;

/** Connection strings with embedded credentials (`scheme://user:pass@host`) — always masked. */
const CREDENTIAL_URL_PATTERN = /:\/\/[^/\s:@]+:[^/\s@]+@/;

/** Pattern-matching keys that are nonetheless public/non-sensitive — never masked. */
const PUBLIC_KEY_ALLOWLIST = new Set([
  'JWT_SIGNING_KID',
  'JWT_PUBLIC_KEY',
  'CAPTCHA_SITE_KEY',
  'OAUTH_GOOGLE_CLIENT_ID',
  'OAUTH_GITHUB_CLIENT_ID',
  'POSTHOG_KEY', // PostHog project key is public by design (ships to the browser)
  'STRIPE_PUBLISHABLE_KEY', // publishable key is public by design (ships to the browser)
  'SENTRY_FRONTEND_DSN', // frontend DSN is public by design (ships to the browser)
]);

/**
 * The browser-safe keys clinozy-fe needs, paired with the frontend's own `VITE_`-prefixed names.
 * All are public, so the frontend bundle can be printed directly (pasteable) — unlike the backend
 * full-env copy, which must go via the clipboard because it carries real secrets.
 */
const FRONTEND_KEYS = FRONTEND_ENV_KEY_MAPPINGS;

export interface OutputOptions {
  /** Limit to a single environment name (from config.environments[].name). */
  environment?: string;
  /** Copy the real value of exactly this one key to the clipboard (audit-logged). */
  copy?: string;
  /**
   * Copy the ENTIRE `.env.<environment>` (all keys, real values) to the clipboard — the
   * pasteable full backend env. Never printed to stdout because it carries secrets.
   */
  copyAll?: boolean;
  /** Seconds before the clipboard is auto-cleared after a `--copy` / `--copy-all` (default 30). */
  clearSeconds?: number;
}

/** Options for `setup:infra:frontend` — the browser-safe clinozy-fe key bundle. */
export interface FrontendOptions {
  /** Environment name (defaults to the configured default environment). */
  environment?: string;
  /** Emit the frontend's `VITE_`-prefixed names instead of the canonical backend names. */
  vite?: boolean;
}

export function isSensitive(key: string, value: string): boolean {
  if (CREDENTIAL_URL_PATTERN.test(value)) return true;
  if (PUBLIC_KEY_ALLOWLIST.has(key)) return false;
  return SENSITIVE_PATTERN.test(key);
}

function mask(value: string): string {
  return value.length === 0 ? '(empty)' : '••••••••';
}

function recordReveal(key: string, environment: string): void {
  try {
    mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true });
    appendFileSync(
      AUDIT_LOG_PATH,
      `${new Date().toISOString()} copied ${key} for ${environment}\n`,
      'utf-8',
    );
  } catch {
    // Audit logging is best-effort; never block a copy on it.
  }
}

function resolveEnvironments(config: ReturnType<typeof loadConfig>, requested?: string): string[] {
  const all = getEnvironmentNames(config);
  if (!requested) return all;
  const match = all.filter((name) => name === requested);
  if (match.length === 0) {
    throw new SetupError(`Unknown environment "${requested}". Configured: ${all.join(', ')}`);
  }
  return match;
}

/** `--copy <KEY>`: copy one value to the clipboard, never printing it. */
async function copyValueToClipboard(options: OutputOptions & { copy: string }): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const state = loadState();
  // Default to the single configured default environment when none is given.
  const environment =
    options.environment ??
    config.environments.find((candidate) => candidate.isDefault)?.name ??
    getEnvironmentNames(config)[0];

  if (!environment) {
    throw new SetupError('No environments configured.');
  }

  const variables = resolveEnvironmentVariables(environment, config, secrets, state);
  const value = String(variables[options.copy] ?? '');

  if (value.length === 0) {
    throw new SetupError(`"${options.copy}" is empty or not set for "${environment}".`);
  }

  if (!clipboardAvailable()) {
    throw new SetupError('No clipboard tool found (need pbcopy / wl-copy / xclip / xsel / clip).', {
      hint: `Read the value from .env.${environment} directly — it is never printed.`,
    });
  }

  if (!copyToClipboard(value)) {
    throw new SetupError('Failed to write to the clipboard.');
  }

  recordReveal(options.copy, environment);
  const clearSeconds = resolveClearSeconds(options.clearSeconds);
  logger.success(
    `${options.copy} for "${environment}" → copied to clipboard (not shown). Clearing in ${clearSeconds}s…`,
  );

  await new Promise((done) => setTimeout(done, clearSeconds * 1000));
  clearClipboard();
  logger.info('Clipboard cleared.');
}

/** Resolve the single environment to operate on (explicit, else the configured default). */
function resolveSingleEnvironment(
  config: ReturnType<typeof loadConfig>,
  requested?: string,
): string {
  const environment =
    requested ??
    config.environments.find((candidate) => candidate.isDefault)?.name ??
    getEnvironmentNames(config)[0];
  if (!environment) throw new SetupError('No environments configured.');
  return environment;
}

/** `--copy-all`: copy the entire `.env.<environment>` (all keys, real values) to the clipboard. */
async function copyFullEnvToClipboard(options: OutputOptions): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const state = loadState();
  const environment = resolveSingleEnvironment(config, options.environment);
  const variables = resolveEnvironmentVariables(environment, config, secrets, state);

  const block = Object.keys(variables)
    .sort()
    .map((key) => `${key}=${variables[key]}`)
    .join('\n');
  if (block.length === 0) {
    throw new SetupError(`No values resolved for "${environment}".`);
  }
  if (!clipboardAvailable()) {
    throw new SetupError('No clipboard tool found (need pbcopy / wl-copy / xclip / xsel / clip).', {
      hint: `Read the values from .env.${environment} directly — they are never printed.`,
    });
  }
  if (!copyToClipboard(block)) {
    throw new SetupError('Failed to write to the clipboard.');
  }

  recordReveal('<full env>', environment);
  const clearSeconds = resolveClearSeconds(options.clearSeconds);
  logger.success(
    `Full .env.${environment} copied to clipboard (${Object.keys(variables).length} keys, not shown). ` +
      `Clearing in ${clearSeconds}s…`,
  );
  await new Promise((done) => setTimeout(done, clearSeconds * 1000));
  clearClipboard();
  logger.info('Clipboard cleared.');
}

/**
 * `setup:infra:frontend` — print the browser-safe clinozy-fe key bundle for one environment. Every
 * value is public (ships to the browser), so it is printed directly (pasteable). Use `--vite` for
 * the frontend's `VITE_`-prefixed names; default emits the canonical backend names.
 */
export function runFrontend(options: FrontendOptions = {}): void {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const state = loadState();
  const environment = resolveSingleEnvironment(config, options.environment);
  const variables = resolveEnvironmentVariables(environment, config, secrets, state);

  logger.info(`# clinozy-fe env — ${environment}${options.vite ? '' : '  (canonical names)'}`);
  for (const { canonical, vite } of FRONTEND_KEYS) {
    const name = options.vite ? vite : canonical;
    const value = variables[canonical] ?? '';
    logger.info(
      value ? `${name}=${value}` : `# ${name}=  (not set — provision the provider first)`,
    );
  }
  logger.info(
    `Also written to ../clinozy-fe/${frontendEnvFileName(environment)} by pnpm setup:infra:export-env.`,
  );
}

/** Render the masked inventory for each environment (no secret value is printed). */
function printMaskedInventory(options: OutputOptions): void {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const state = loadState();
  const environments = resolveEnvironments(config, options.environment);

  logger.info(`Project: ${config.project.displayName} (${config.project.name})`);
  logger.info(`Organization: ${config.project.organization}`);
  logger.blank();

  for (const environment of environments) {
    const variables = resolveEnvironmentVariables(environment, config, secrets, state);
    logger.info(`# ${environment}`);
    for (const key of Object.keys(variables).sort()) {
      const value = String(variables[key] ?? '');
      logger.info(`  ${key} = ${isSensitive(key, value) ? `${mask(value)}  (sensitive)` : value}`);
    }
    logger.blank();
  }

  logger.info(
    'Secrets are never printed. Copy one to the clipboard: pnpm setup:infra:output --copy <KEY>',
  );
  logger.info('Or just provision — values are written straight into .env.<environment>.');
}

/** Entry point for `setup:infra:output`. */
export async function runOutput(options: OutputOptions = {}): Promise<void> {
  if (options.copyAll) {
    await copyFullEnvToClipboard(options);
    return;
  }
  if (options.copy) {
    await copyValueToClipboard({ ...options, copy: options.copy });
    return;
  }
  printMaskedInventory(options);
}
