import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { toolRoot } from '@setup/common/paths.js';
import { ensureSecretDir, writeSecretFile } from '@setup/common/secure-file.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { SetupConfig, SetupSecrets } from './types.js';

const PROJECT_ROOT = toolRoot();
// Setup-tooling input credentials live in the gitignored `.setup/` directory, deliberately
// kept OUT of the app's `.env.<environment>` namespace so the two are never confused. The
// committed template lives at the repo root as `.setup-credentials.example` (next to
// `.env.example`) for discoverability. (State is ephemeral/in-memory — no file lives here.)
const SETUP_DIR = resolve(PROJECT_ROOT, '.setup');
const ENV_SETUP_PATH = resolve(SETUP_DIR, '.setup-credentials');

const TOKEN_URLS: Record<string, string> = {
  NEON_API_KEY: 'https://console.neon.tech/app/settings/api-keys',
  NEON_ORG_ID: 'https://console.neon.tech/app/settings (Organization → General → Organization ID)',
  AWS_ACCESS_KEY_ID: 'https://console.aws.amazon.com/iam/home#/users',
  AWS_SECRET_ACCESS_KEY: 'https://console.aws.amazon.com/iam/home#/users',
  SENTRY_AUTH_TOKEN: 'https://sentry.io/settings/auth-tokens/new-token/',
  RESEND_API_KEY: 'https://resend.com/api-keys',
  GITHUB_TOKEN: 'https://github.com/settings/tokens',
  RAILWAY_API_TOKEN: 'https://railway.com/account/tokens',
  POSTHOG_PERSONAL_API_KEY: 'https://us.posthog.com/settings/user-api-keys',
  POSTMAN_API_KEY: 'https://go.postman.co/settings/me/api-keys (setup creates the workspace)',
  SCALAR_API_KEY: 'https://dashboard.scalar.com → API Keys (setup resolves the team namespace)',
  CLOUDFLARE_API_TOKEN:
    'https://dash.cloudflare.com/profile/api-tokens (token with Turnstile:Edit)',
  CLOUDFLARE_ACCOUNT_ID:
    'https://dash.cloudflare.com → any domain → Overview (Account ID in the right sidebar)',
  NETLIFY_AUTH_TOKEN:
    'https://app.netlify.com/user/applications#personal-access-tokens (optional when logged in with the Netlify CLI)',
};

const SIMPLE_VARS: Array<[string, string]> = [
  ['NEON_API_KEY', TOKEN_URLS.NEON_API_KEY ?? ''],
  ['NEON_ORG_ID', TOKEN_URLS.NEON_ORG_ID ?? ''],
  ['AWS_ACCESS_KEY_ID', TOKEN_URLS.AWS_ACCESS_KEY_ID ?? ''],
  ['AWS_SECRET_ACCESS_KEY', TOKEN_URLS.AWS_SECRET_ACCESS_KEY ?? ''],
  ['SENTRY_AUTH_TOKEN', TOKEN_URLS.SENTRY_AUTH_TOKEN ?? ''],
  ['RESEND_API_KEY', TOKEN_URLS.RESEND_API_KEY ?? ''],
  ['GITHUB_TOKEN', TOKEN_URLS.GITHUB_TOKEN ?? ''],
  ['RAILWAY_API_TOKEN', TOKEN_URLS.RAILWAY_API_TOKEN ?? ''],
  // Postman: setup uses this account API key to create the workspace + upload a per-env collection.
  ['POSTMAN_API_KEY', TOKEN_URLS.POSTMAN_API_KEY ?? ''],
  // Scalar: setup uses this account API key to publish the OpenAPI doc; the team namespace is
  // auto-resolved from the token (per-env slug `<project>-<env>`).
  ['SCALAR_API_KEY', TOKEN_URLS.SCALAR_API_KEY ?? ''],
  // Cloudflare Turnstile is PROVISIONED by setup: with a Cloudflare API token + account id, the
  // provider creates one widget per environment and writes CAPTCHA_SITE_KEY/CAPTCHA_SECRET into
  // each .env.<environment>. So the inputs here are the Cloudflare credentials, not CAPTCHA_*.
  ['CLOUDFLARE_API_TOKEN', TOKEN_URLS.CLOUDFLARE_API_TOKEN ?? ''],
  ['CLOUDFLARE_ACCOUNT_ID', TOKEN_URLS.CLOUDFLARE_ACCOUNT_ID ?? ''],
  // Netlify: setup finds (or creates) the frontend's site and writes NETLIFY_SITE_ID +
  // NETLIFY_AUTH_TOKEN into the frontend env. Falls back to the Netlify CLI's saved login.
  ['NETLIFY_AUTH_TOKEN', TOKEN_URLS.NETLIFY_AUTH_TOKEN ?? ''],
];

// ─── Zod schemas ────────────────────────────────────────────────────────────

// NOTE: app-level per-environment secrets are entered directly in `.env.<environment>` (NOT in
// `.setup/.setup-credentials` — no env-suffixed keys here):
//   - OAuth (Google + GitHub): validated by reading the env files.
//   - Stripe: prompted from stdin and written as STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET.
// Cloudflare Turnstile is PROVISIONED: setup uses CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to
// create one widget per environment and writes CAPTCHA_SITE_KEY / CAPTCHA_SECRET into each env file.

export const setupSecretsSchema = z.object({
  neon: z.object({
    apiKey: z.string(),
    orgId: z.string().optional(),
  }),
  aws: z.object({
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
  }),
  sentry: z.object({
    authToken: z.string(),
  }),
  resend: z.object({
    apiKey: z.string(),
  }),
  railway: z.object({
    /**
     * Account / project-wide token (Bearer auth). Required at setup time when the Railway
     * provider is enabled — gives full project lifecycle (create project, list user
     * projects, mint per-environment project tokens via `projectTokenCreate`, read/write
     * variables across environments). Set via `RAILWAY_API_TOKEN` in `.setup-credentials`.
     * Stays in `.setup-credentials` only; never pushed to GitHub Environments or Railway service
     * variables. Per-environment runtime tokens are minted from this and persisted into
     * `state.railway.environmentTokens`, then written into each `.env.<env>` as
     * `RAILWAY_TOKEN`.
     */
    apiToken: z.string().optional(),
  }),
  /**
   * Cloudflare credentials used to PROVISION Turnstile. With these, the Turnstile provider
   * creates one widget per environment and writes `CAPTCHA_SITE_KEY` / `CAPTCHA_SECRET` into each
   * `.env.<environment>`. The widget API is account-scoped, so both token and account id are needed.
   */
  cloudflare: z.object({
    /** API token with Turnstile:Edit (`CLOUDFLARE_API_TOKEN`). */
    apiToken: z.string().optional(),
    /** Account id the widget is created under (`CLOUDFLARE_ACCOUNT_ID`). */
    accountId: z.string().optional(),
  }),
  /**
   * Postman account API key (`POSTMAN_API_KEY`). Setup-only credential — it provisions the
   * workspace + uploads the collection and is never written into `.env.<environment>`. Stays
   * in `.setup-credentials` (same place as the other account-wide provider tokens).
   */
  postman: z.object({
    /** Personal API key (`PMAK-…`) used for `X-Api-Key` auth against the Postman API. */
    apiKey: z.string().optional(),
  }),
  /**
   * Scalar account API key (`SCALAR_API_KEY`). Setup-only credential — it publishes the OpenAPI
   * document to the Scalar Registry and is never written into `.env.<environment>`. The team
   * namespace is auto-resolved from the token (the active team); slug defaults to the project
   * name. `namespace` / `slug` are optional pins for multi-team accounts or a custom slug.
   */
  /**
   * GitHub token (`GITHUB_TOKEN`). Besides driving `gh` for repo/env setup, it is the token the
   * apps' release automation uses: emitted as `RELEASE_PLEASE_TOKEN` (GitHub offers no API to mint
   * a personal token, so the one the operator already provided is the source).
   */
  github: z.object({ token: z.string().optional() }),
  /**
   * Netlify personal access token (`NETLIFY_AUTH_TOKEN`), or the Netlify CLI's saved login when
   * absent. Finds/creates the frontend site and is emitted into the frontend env, where the
   * frontend's CI uses it to deploy.
   */
  netlify: z.object({ authToken: z.string().optional() }),
  scalar: z.object({
    /** Account API key used by `scalar auth login --token`. */
    apiKey: z.string().optional(),
    /** Optional team namespace override (`SCALAR_NAMESPACE`); auto-resolved when omitted. */
    namespace: z.string().optional(),
    /** Optional registry slug override (`SCALAR_SLUG`); defaults to the project name. */
    slug: z.string().optional(),
  }),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function getEnvSource(): Record<string, string> {
  const fromFile: Record<string, string> = {};
  if (existsSync(ENV_SETUP_PATH)) {
    try {
      const content = readFileSync(ENV_SETUP_PATH, 'utf-8');
      Object.assign(fromFile, parseEnvFile(content));
    } catch {
      // ignore read errors
    }
  }
  const merged: Record<string, string> = { ...fromFile };
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      merged[key] = value;
    }
  }
  return merged;
}

function get(source: Record<string, string>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Where the Netlify CLI keeps its login (`netlify login`), per platform. */
function netlifyCliConfigPath(): string {
  if (process.platform === 'darwin') {
    return resolve(homedir(), 'Library', 'Preferences', 'netlify', 'config.json');
  }
  if (process.platform === 'win32') {
    return resolve(process.env.APPDATA ?? homedir(), 'netlify', 'Config', 'config.json');
  }
  return resolve(
    process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'),
    'netlify',
    'config.json',
  );
}

/**
 * The active user's token from the Netlify CLI config text (`{ userId, users: { <id>: { auth:
 * { token } } } }`), or '' when there is no usable login. Mirrors how the GitHub and Railway CLIs
 * stand in for a token elsewhere in setup.
 */
export function netlifyTokenFromCliConfig(configText: string): string {
  try {
    const parsed = JSON.parse(configText) as {
      userId?: string;
      users?: Record<string, { auth?: { token?: string } }>;
    };
    const token = parsed.userId ? parsed.users?.[parsed.userId]?.auth?.token : undefined;
    return typeof token === 'string' ? token.trim() : '';
  } catch {
    return '';
  }
}

function netlifyCliToken(): string {
  const path = netlifyCliConfigPath();
  if (!existsSync(path)) return '';
  try {
    return netlifyTokenFromCliConfig(readFileSync(path, 'utf-8'));
  } catch {
    return '';
  }
}

// ─── Load secrets from .setup-credentials ────────────────────────────────────

export function loadSecretsFromEnv(_environmentNames: string[]): SetupSecrets {
  const source = getEnvSource();

  return {
    neon: { apiKey: get(source, 'NEON_API_KEY'), orgId: get(source, 'NEON_ORG_ID') || undefined },
    aws: {
      accessKeyId: get(source, 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: get(source, 'AWS_SECRET_ACCESS_KEY'),
    },
    sentry: { authToken: get(source, 'SENTRY_AUTH_TOKEN') },
    resend: { apiKey: get(source, 'RESEND_API_KEY') },
    railway: {
      apiToken: get(source, 'RAILWAY_API_TOKEN') || undefined,
    },
    cloudflare: {
      apiToken: get(source, 'CLOUDFLARE_API_TOKEN') || undefined,
      accountId: get(source, 'CLOUDFLARE_ACCOUNT_ID') || undefined,
    },
    postman: {
      apiKey: get(source, 'POSTMAN_API_KEY') || undefined,
    },
    github: { token: get(source, 'GITHUB_TOKEN') || undefined },
    netlify: { authToken: get(source, 'NETLIFY_AUTH_TOKEN') || netlifyCliToken() || undefined },
    scalar: {
      apiKey: get(source, 'SCALAR_API_KEY') || undefined,
      namespace: get(source, 'SCALAR_NAMESPACE') || undefined,
      slug: get(source, 'SCALAR_SLUG') || undefined,
    },
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function loadSecrets(config: SetupConfig): z.infer<typeof setupSecretsSchema> {
  const environmentNames = config.environments.map((environment) => environment.name);
  return loadSecretsFromEnv(environmentNames);
}

export function reloadSecrets(config: SetupConfig): z.infer<typeof setupSecretsSchema> {
  return loadSecrets(config);
}

export function isSecretFilled(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function getSecretsPath(): string {
  return ENV_SETUP_PATH;
}

export function envSetupFileExists(): boolean {
  return existsSync(ENV_SETUP_PATH);
}

export function getEnvSetupValue(key: string): string {
  const source = getEnvSource();
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function setEnvSetupVariable(key: string, value: string): void {
  if (!existsSync(ENV_SETUP_PATH)) return;
  let content = readFileSync(ENV_SETUP_PATH, 'utf-8');
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRegex = new RegExp(`^(${escapedKey}=).*`, 'm');
  if (lineRegex.test(content)) {
    content = content.replace(lineRegex, `$1${value}`);
  } else {
    const comment = TOKEN_URLS[key as keyof typeof TOKEN_URLS] ?? key;
    content = `${content.trimEnd()}\n\n# ${comment}\n${key}=${value}\n`;
  }
  writeSecretFile(ENV_SETUP_PATH, content);
}

export function hasGithubToken(): boolean {
  const source = getEnvSource();
  const value = get(source, 'GITHUB_TOKEN');
  return value.length > 0;
}

export function hasAnyEnvSecret(environmentNames: string[]): boolean {
  const secrets = loadSecretsFromEnv(environmentNames);
  const filled = (value: string | undefined) =>
    typeof value === 'string' && value.trim().length > 0;
  return (
    filled(secrets.neon.apiKey) ||
    filled(secrets.aws.accessKeyId) ||
    filled(secrets.sentry.authToken) ||
    filled(secrets.resend.apiKey) ||
    filled(secrets.railway.apiToken) ||
    filled(secrets.cloudflare.apiToken) ||
    filled(secrets.postman.apiKey) ||
    filled(secrets.scalar.apiKey)
  );
}

export function loadEnvSetupIntoProcess(): void {
  if (!existsSync(ENV_SETUP_PATH)) return;
  try {
    const content = readFileSync(ENV_SETUP_PATH, 'utf-8');
    const parsed = parseEnvFile(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== '' && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore
  }
}

// ─── Template generation ────────────────────────────────────────────────────

export function buildEnvSetupTemplateContent(config: SetupConfig): string {
  const environmentNames = config.environments.map((environment) => environment.name);
  const lines: string[] = [
    '# Setup secrets — fill each value and run pnpm setup.',
    '# Get each key from the URL on the line above the variable.',
    '',
    '# Project / organization / environments (to change these, edit tooling/setup/setup.config.json and re-run pnpm setup --init)',
    `# Project: ${config.project.displayName} (${config.project.name})`,
    `# Organization: ${config.project.organization}`,
    `# Environments: ${environmentNames.join(', ')}`,
    '',
  ];

  for (const [key, url] of SIMPLE_VARS) {
    lines.push(`# ${url}`);
    lines.push(`${key}=`);
    lines.push('');
  }

  // App-level per-environment secrets are NOT templated here — the environment is the
  // `.env.<environment>` file, not a key suffix. Setup prompts for these from stdin at apply time
  // (or you enter them directly in each env file):
  lines.push(
    '# App per-environment secrets are prompted at apply and written to .env.<environment>',
  );
  lines.push('#   (NOT here — the environment is the file, not a key suffix):');
  lines.push(
    '#   Stripe:    STRIPE_SECRET_KEY=  STRIPE_WEBHOOK_SECRET=  (test in dev, live in prod)',
  );
  lines.push(
    '#   OAuth:     OAUTH_GOOGLE_CLIENT_ID/_CLIENT_SECRET/_REDIRECT_URI  (+ OAUTH_GITHUB_*)',
  );
  lines.push(
    '#   Turnstile: CAPTCHA_* are PROVISIONED from CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID',
  );
  lines.push(
    '#   PostHog:   POSTHOG_PERSONAL_API_KEY=  (setup resolves POSTHOG_KEY + POSTHOG_HOST)',
  );
  lines.push(
    '# (See SETUP_INFRA_PREREQUISITES.md.) Providers read/validate these from .env.<environment>.',
  );
  return lines.join('\n');
}

export function writeEnvSetupTemplateIfMissing(config: SetupConfig): boolean {
  if (existsSync(ENV_SETUP_PATH)) return false;
  ensureSecretDir(ENV_SETUP_PATH);
  writeSecretFile(ENV_SETUP_PATH, buildEnvSetupTemplateContent(config));
  return true;
}

export function appendMissingEnvSetupVariables(_config: SetupConfig): string[] {
  if (!existsSync(ENV_SETUP_PATH)) return [];
  const content = readFileSync(ENV_SETUP_PATH, 'utf-8');
  const existingKeys = new Set(Object.keys(parseEnvFile(content)));
  const appended: string[] = [];
  const blocks: string[] = [];

  // Only account-wide, env-agnostic credential keys are templated. App per-environment secrets
  // (Stripe / OAuth / Turnstile-via-Cloudflare) are prompted/provisioned into `.env.<environment>`.
  for (const [key, url] of SIMPLE_VARS) {
    if (!existingKeys.has(key)) {
      blocks.push(`# ${url}\n${key}=`);
      appended.push(key);
    }
  }

  if (blocks.length === 0) return [];
  const trimmed = content.trimEnd();
  const suffix = trimmed.endsWith('\n') ? '' : '\n';
  writeSecretFile(ENV_SETUP_PATH, `${trimmed + suffix}\n${blocks.join('\n\n')}\n`);
  return appended;
}

export function ensureEnvSetupTemplate(config: SetupConfig): boolean {
  return writeEnvSetupTemplateIfMissing(config);
}

const ENV_SETUP_HEADER_PREFIX = '# Project / organization / environments';
const ENV_SETUP_HEADER_END = '# Environments:';

export function updateEnvSetupHeader(config: SetupConfig): boolean {
  if (!existsSync(ENV_SETUP_PATH)) return false;
  const environmentNames = config.environments.map((environment) => environment.name);
  const newHeaderLines = [
    `${ENV_SETUP_HEADER_PREFIX} (to change these, edit tooling/setup/setup.config.json and re-run pnpm setup --init)`,
    `# Project: ${config.project.displayName} (${config.project.name})`,
    `# Organization: ${config.project.organization}`,
    `# Environments: ${environmentNames.join(', ')}`,
    '',
  ];

  let content = readFileSync(ENV_SETUP_PATH, 'utf-8');
  const prefixIndex = content.indexOf(ENV_SETUP_HEADER_PREFIX);
  if (prefixIndex === -1) {
    const insertAfter = content.indexOf('\n\n');
    const insertAt = insertAfter === -1 ? content.length : insertAfter + 2;
    content = `${content.slice(0, insertAt)}\n${newHeaderLines.join('\n')}${content.slice(insertAt)}`;
  } else {
    const lineStart = content.lastIndexOf('\n', prefixIndex) + 1;
    const endMarkerIndex = content.indexOf(ENV_SETUP_HEADER_END, prefixIndex);
    const afterEnvLine =
      endMarkerIndex === -1 ? prefixIndex : content.indexOf('\n', endMarkerIndex) + 1;
    const endIndex = afterEnvLine <= 0 ? content.length : afterEnvLine;
    content = content.slice(0, lineStart) + newHeaderLines.join('\n') + content.slice(endIndex);
  }
  writeSecretFile(ENV_SETUP_PATH, content);
  return true;
}
