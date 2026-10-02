/**
 * Sync a local `.env.<environment>` file to its matching GitHub Environment.
 *
 * Classification is rule-based, NOT section-based. The `.env.example` half
 * headers ("GitHub Secrets" / "GitHub Variables") are for human readability
 * only. The push logic classifies each key via `classifyKey()` — a strict
 * rule set that cannot drift due to wrong-section placement.
 *
 * Reconciliation:
 *   - Items in the local file but missing on GitHub → created.
 *   - Variables with changed values → updated.
 *   - Secrets are always re-encrypted and pushed (GitHub hides secret values).
 *   - Items on GitHub but NOT in the local file → DELETED (the file is truth).
 *   - Variables with unchanged values → skipped.
 *
 * Empty values in the local file are skipped (not pushed), but they also won't
 * trigger deletion of an existing remote item — use an explicit removal from
 * the file to trigger deletion.
 *
 * Usage:
 *   pnpm github:sync development
 *   pnpm github:sync --all                          # reconcile every configured environment
 *   pnpm github:sync production --dry-run           # show what would be pushed
 */

import { execSync } from 'node:child_process';
import { targetRoot } from '@setup/common/paths.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import sodium from 'libsodium-wrappers';

import { runGhAuthPreflight } from './auth-preflight.js';

const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 240_000] as const;

/**
 * Minimum spacing between MUTATIVE requests (POST/PUT/PATCH/DELETE). GitHub's secondary
 * (abuse-detection) rate limit fires on bursts of writes even when the primary quota is healthy,
 * and its guidance is ≥1s between mutative calls. The primary-quota pacing can dip to ~250ms, so
 * writes are floored here to stay under the secondary limit.
 */
const MUTATION_MIN_DELAY_MS = 1_100;

/** Minimum wait when a 429 is the SECONDARY rate limit (no Retry-After header — needs a real pause). */
const SECONDARY_RATE_LIMIT_MIN_WAIT_MS = 60_000;

/**
 * Dynamic-delay tuning. Between every successful request we wait
 * `clamp(timeToReset / remaining, MIN, MAX)` so a long batch is paced evenly
 * across the GitHub primary-rate-limit window. This avoids the secondary
 * abuse-detection rate limit that fires on bursts of writes to the same
 * environment, even when the primary quota is healthy.
 */
const DYNAMIC_DELAY_MIN_MS = 250;
const DYNAMIC_DELAY_MAX_MS = 5_000;
const DYNAMIC_DELAY_DEFAULT_MS = 350;
const DYNAMIC_DELAY_LOW_REMAINING_THRESHOLD = 50;

interface RateLimitState {
  remaining: number | null;
  resetAtMs: number | null;
  retryAfterMs: number | null;
}

const rateLimitState: RateLimitState = {
  remaining: null,
  resetAtMs: null,
  retryAfterMs: null,
};

function parseIntegerHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw === '') return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function recordRateLimitHeaders(headers: Headers): void {
  const remaining = parseIntegerHeader(headers, 'x-ratelimit-remaining');
  const resetSeconds = parseIntegerHeader(headers, 'x-ratelimit-reset');
  const retryAfterSeconds = parseIntegerHeader(headers, 'retry-after');
  if (remaining !== null) rateLimitState.remaining = remaining;
  if (resetSeconds !== null) rateLimitState.resetAtMs = resetSeconds * 1_000;
  rateLimitState.retryAfterMs = retryAfterSeconds === null ? null : retryAfterSeconds * 1_000;
}

function computeDynamicDelayMs(): number {
  const { remaining, resetAtMs, retryAfterMs } = rateLimitState;

  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, DYNAMIC_DELAY_MAX_MS);
  }

  if (remaining === null || resetAtMs === null) {
    return DYNAMIC_DELAY_DEFAULT_MS;
  }

  const timeToResetMs = resetAtMs - Date.now();
  if (timeToResetMs <= 0) return DYNAMIC_DELAY_MIN_MS;

  if (remaining <= 0) {
    return Math.min(timeToResetMs, DYNAMIC_DELAY_MAX_MS);
  }

  const evenSpacingMs = Math.ceil(timeToResetMs / remaining);

  // When quota is plentiful, stay near the floor; when it's tight, slow down.
  const baseDelayMs =
    remaining > DYNAMIC_DELAY_LOW_REMAINING_THRESHOLD
      ? Math.max(DYNAMIC_DELAY_MIN_MS, Math.min(evenSpacingMs, DYNAMIC_DELAY_DEFAULT_MS))
      : evenSpacingMs;

  return Math.min(Math.max(baseDelayMs, DYNAMIC_DELAY_MIN_MS), DYNAMIC_DELAY_MAX_MS);
}

interface GitHubEnvironmentPublicKey {
  readonly key_id: string;
  readonly key: string;
}

interface GitHubEnvironmentVariablesResponse {
  readonly variables: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
}

interface GitHubEnvironmentSecretsResponse {
  readonly secrets: ReadonlyArray<{
    readonly name: string;
  }>;
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function getGitHubToken(): string {
  return execSync('gh auth token', { encoding: 'utf-8' }).trim();
}

function getRepositoryFullName(): string {
  return execSync('gh api repos/:owner/:repo --jq .full_name', {
    encoding: 'utf-8',
  }).trim();
}

function buildGitHubApiUrl(pathname: string): string {
  return `https://api.github.com/${pathname.replace(/^\/+/, '')}`;
}

async function requestGitHub<T>(
  token: string,
  label: string,
  pathname: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const isMutation = method !== 'GET';
  const dynamicDelayMs = computeDynamicDelayMs();
  // Writes are floored at MUTATION_MIN_DELAY_MS to avoid tripping the secondary (abuse) limit.
  const preRequestDelayMs = isMutation
    ? Math.max(dynamicDelayMs, MUTATION_MIN_DELAY_MS)
    : dynamicDelayMs;
  if (preRequestDelayMs > 0) {
    await sleep(preRequestDelayMs);
  }

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(buildGitHubApiUrl(pathname), {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    recordRateLimitHeaders(response.headers);

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    const responseText = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= RATE_LIMIT_BACKOFF_MS.length) {
      throw new GitHubApiError(
        response.status,
        `${label}: HTTP ${response.status} ${responseText}`,
      );
    }
    const retryAfterMs = rateLimitState.retryAfterMs;
    const fallbackBackoffMs =
      RATE_LIMIT_BACKOFF_MS[attempt] ??
      RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1] ??
      1000;
    // Secondary (abuse) rate limit sends no Retry-After — back off at least a minute (and keep
    // climbing via the backoff schedule) so it actually clears instead of hammering it.
    const secondaryRateLimit =
      response.status === 429 && /secondary rate limit/i.test(responseText);
    const secondaryFloorMs = secondaryRateLimit ? SECONDARY_RATE_LIMIT_MIN_WAIT_MS : 0;
    const waitMs = Math.max(
      retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : 0,
      fallbackBackoffMs,
      secondaryFloorMs,
    );
    console.warn(
      `  ! GitHub API throttled "${label}" — backing off ${formatDuration(waitMs)} ` +
        `(retry ${attempt + 1}/${RATE_LIMIT_BACKOFF_MS.length})`,
    );
    await sleep(waitMs);
  }
}

export interface SyncEnvironmentToGitHubOptions {
  readonly environment: string;
  readonly dryRun: boolean;
  readonly skipCreate?: boolean;
  readonly skipPreflight?: boolean;
}

interface EnvEntry {
  name: string;
  value: string;
}

/** Rule-based classification — the file structure is for readability only. */
export function classifyKey(key: string): 'secret' | 'variable' {
  // Credential / signing material suffixes → Secret
  if (key.endsWith('_API_KEY')) return 'secret';
  if (key.endsWith('_SECRET_KEY')) return 'secret';
  if (key.endsWith('_WEBHOOK_SECRET')) return 'secret';
  if (key.endsWith('_PRIVATE_KEY')) return 'secret';
  if (key.endsWith('_ACCESS_KEY_ID')) return 'secret';
  if (key.endsWith('_SECRET_ACCESS_KEY')) return 'secret';
  if (key.endsWith('_ENCRYPTION_KEY')) return 'secret';
  if (key.endsWith('_TOKEN')) return 'secret';
  if (key.endsWith('_DSN')) return 'secret';
  // Deploy-provider service / workspace IDs (e.g. RAILWAY_SERVICE_ID,
  // RAILWAY_WORKER_SERVICE_ID, POSTMAN_WORKSPACE_ID) are read via `secrets.*`
  // in workflows, so they ship as Secrets, not Variables.
  if (key.endsWith('_SERVICE_ID')) return 'secret';
  if (key.endsWith('_WORKSPACE_ID')) return 'secret';

  // Connection strings with embedded credentials → Secret
  if (key.startsWith('DATABASE_') && key.endsWith('_URL')) return 'secret';
  if (key === 'REDIS_URL' || key === 'REDIS_BULLMQ_URL') return 'secret';

  // Auth secrets → Secret
  if (key === 'JWT_SECRET') return 'secret';
  if (key.endsWith('_CLIENT_SECRET')) return 'secret';
  if (key === 'CAPTCHA_SECRET') return 'secret';

  // Everything else → Variable (public ids, knobs, flags, URLs, keys with _PUBLIC_KEY, etc.)
  return 'variable';
}

/**
 * Flat parser — reads all KEY=VALUE pairs into their LOGICAL runtime values
 * via `dotenv.parse`, which strips quotes, decodes `\n`/`\"`/`\\` escapes,
 * and reassembles multi-line single-quoted blocks (PEM keys).
 *
 * Pushing the raw post-`=` text (including literal quotes) is incorrect for
 * GitHub Environment Variables — GitHub stores the value verbatim, so a
 * cron expression written locally as `KEY="0 3 * * *"` would land in GitHub
 * as the literal `"0 3 * * *"` with surrounding quotes and would also fail
 * the value-diff check on the next sync.
 */
function parseEnvFile(filePath: string): EnvEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  const parsed = dotenv.parse(content);
  return Object.entries(parsed)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => ({ name, value }));
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

function padIndex(index: number, total: number): string {
  return String(index).padStart(String(total).length, ' ');
}

async function createGitHubEnvironment(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<void> {
  await requestGitHub<void>(
    token,
    `create env ${environment}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}`,
    { method: 'PUT' },
  );
}

async function githubEnvironmentExists(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<boolean> {
  try {
    await requestGitHub<unknown>(
      token,
      `probe env ${environment}`,
      `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}`,
    );
    return true;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

async function ensureGitHubEnvironment(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<void> {
  if (await githubEnvironmentExists(token, repositoryFullName, environment)) {
    console.log(`GitHub environment "${environment}" already exists; skipping create.`);
    return;
  }
  console.log(`Creating GitHub environment "${environment}"...`);
  await createGitHubEnvironment(token, repositoryFullName, environment);
}

async function getEnvironmentPublicKey(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<GitHubEnvironmentPublicKey> {
  return requestGitHub<GitHubEnvironmentPublicKey>(
    token,
    `fetch public key for ${environment}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/secrets/public-key`,
  );
}

async function fetchExistingSecrets(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<Set<string>> {
  try {
    const response = await requestGitHub<GitHubEnvironmentSecretsResponse>(
      token,
      `fetch secrets for ${environment}`,
      `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/secrets?per_page=100`,
    );
    return new Set(response.secrets.map((s) => s.name));
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return new Set();
    }
    throw error;
  }
}

async function fetchExistingVariables(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<Map<string, string>> {
  try {
    const response = await requestGitHub<GitHubEnvironmentVariablesResponse>(
      token,
      `fetch variables for ${environment}`,
      `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/variables?per_page=100`,
    );
    return new Map(response.variables.map((entry) => [entry.name, entry.value]));
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return new Map();
    }
    throw error;
  }
}

async function setSecret(
  token: string,
  repositoryFullName: string,
  environment: string,
  publicKey: GitHubEnvironmentPublicKey,
  name: string,
  value: string,
): Promise<void> {
  await sodium.ready;
  const encryptedValue = sodium.to_base64(
    sodium.crypto_box_seal(
      sodium.from_string(value),
      sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL),
    ),
    sodium.base64_variants.ORIGINAL,
  );
  await requestGitHub<void>(
    token,
    `set secret ${name}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/secrets/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      body: {
        encrypted_value: encryptedValue,
        key_id: publicKey.key_id,
      },
    },
  );
}

async function deleteSecret(
  token: string,
  repositoryFullName: string,
  environment: string,
  name: string,
): Promise<void> {
  await requestGitHub<void>(
    token,
    `delete secret ${name}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/secrets/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}

async function deleteVariable(
  token: string,
  repositoryFullName: string,
  environment: string,
  name: string,
): Promise<void> {
  await requestGitHub<void>(
    token,
    `delete variable ${name}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/variables/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}

async function setVariable(
  token: string,
  repositoryFullName: string,
  environment: string,
  existingVariables: Map<string, string>,
  name: string,
  value: string,
): Promise<'created' | 'updated' | 'skipped'> {
  const existingValue = existingVariables.get(name);
  if (existingValue === value) return 'skipped';

  if (existingValue === undefined) {
    try {
      await requestGitHub<void>(
        token,
        `create variable ${name}`,
        `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/variables`,
        {
          method: 'POST',
          body: { name, value },
        },
      );
      return 'created';
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 409) {
        throw error;
      }
    }
  }

  await requestGitHub<void>(
    token,
    `update variable ${name}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/variables/${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      body: { name, value },
    },
  );
  return 'updated';
}

export interface SyncEnvironmentResult {
  pushed: number;
  skipped: number;
  deleted: number;
}

/**
 * Full reconciliation of a single GitHub Environment against its local
 * .env.<environment> file. The file is the source of truth:
 *   - Push all secrets and variables from the file.
 *   - Delete any secret or variable on GitHub that is NOT in the file.
 */
export async function syncEnvironmentToGitHub(
  options: SyncEnvironmentToGitHubOptions,
): Promise<SyncEnvironmentResult> {
  const { environment, dryRun, skipCreate = false, skipPreflight = false } = options;
  const envFilePath = resolve(targetRoot(), `.env.${environment}`);

  if (!existsSync(envFilePath)) {
    throw new Error(
      `Missing .env.${environment} at the repo root. Run \`pnpm setup:github\` without --dry-run to scaffold it from setup.config.json.`,
    );
  }

  const allEntries = parseEnvFile(envFilePath);
  const secrets = allEntries.filter((e) => classifyKey(e.name) === 'secret');
  const variables = allEntries.filter((e) => classifyKey(e.name) === 'variable');

  const localSecretNames = new Set(secrets.map((s) => s.name));
  const localVariableNames = new Set(variables.map((v) => v.name));

  console.log(`Source:      .env.${environment}`);
  console.log(`Environment: ${environment}`);
  console.log(`Plan:        ${secrets.length} secret(s), ${variables.length} variable(s)`);
  console.log('');

  if (dryRun) {
    for (const entry of secrets) console.log(`  [secret]   ${entry.name}`);
    for (const entry of variables) console.log(`  [variable] ${entry.name}`);
    console.log('');
    console.log('Dry run — no API calls made. Drop --dry-run to push.');
    return { pushed: 0, skipped: 0, deleted: 0 };
  }

  const repositoryFullName = getRepositoryFullName();

  if (!skipPreflight && process.env.GITHUB_SYNC_PARENT !== '1') {
    await runGhAuthPreflight({
      repository: repositoryFullName,
      purpose: `Push secrets and variables to GitHub Environment "${environment}"`,
      destructive: true,
    });
  }

  const token = getGitHubToken();
  if (!skipCreate) {
    await ensureGitHubEnvironment(token, repositoryFullName, environment);
  }
  const publicKey = await getEnvironmentPublicKey(token, repositoryFullName, environment);
  const existingSecrets = await fetchExistingSecrets(token, repositoryFullName, environment);
  const existingVariables = await fetchExistingVariables(token, repositoryFullName, environment);

  // ── Push secrets (always, can't diff) ──────────────────────────────────
  const pushTotal = secrets.length + variables.length;
  console.log(`Pushing ${pushTotal} item(s) through the GitHub REST API`);
  console.log(
    '(Variables with unchanged values are skipped; secrets are always re-encrypted and pushed).',
  );
  console.log('');

  const startTime = Date.now();
  let processed = 0;
  let pushed = 0;
  let skipped = 0;

  const push = async (
    kind: 'secret' | 'variable',
    name: string,
    action: () => Promise<'created' | 'updated' | 'skipped' | 'pushed'>,
  ): Promise<void> => {
    const itemStart = Date.now();
    const status = await action();
    const itemDuration = Date.now() - itemStart;

    processed += 1;
    if (status !== 'skipped') pushed += 1;
    else skipped += 1;

    const remaining = pushTotal - processed;
    const elapsed = Date.now() - startTime;
    const averagePerItem = elapsed / processed;
    const estimatedRemaining = Math.round(averagePerItem * remaining);
    const indexLabel = `${padIndex(processed, pushTotal)}/${pushTotal}`;
    const kindLabel = kind === 'secret' ? '[secret]  ' : '[variable]';

    const quotaLabel =
      rateLimitState.remaining !== null ? `, quota ${rateLimitState.remaining}` : '';

    console.log(
      `  ${indexLabel}  ${kindLabel} ${name}  (` +
        `${status}, took ${formatDuration(itemDuration)}, ${remaining} left, ` +
        `ETA ${formatDuration(estimatedRemaining)}${quotaLabel})`,
    );
  };

  for (const entry of secrets) {
    await push('secret', entry.name, async () => {
      await setSecret(token, repositoryFullName, environment, publicKey, entry.name, entry.value);
      return 'pushed';
    });
  }
  for (const entry of variables) {
    await push('variable', entry.name, async () => {
      return setVariable(
        token,
        repositoryFullName,
        environment,
        existingVariables,
        entry.name,
        entry.value,
      );
    });
  }

  // ── Delete stale items (on GitHub but NOT in local file with same kind) ──
  //
  // This covers two cases in a single pass:
  //   1. Item removed from the local .env file (true stale).
  //   2. Item re-classified across kinds, or pushed as the wrong kind by an
  //      older setup-infra version (e.g. ALLOWED_ORIGINS pushed as a Secret
  //      previously, now correctly classified as a Variable). The Secret is
  //      no longer in localSecretNames, so it gets pruned here while the
  //      Variable is created above — no duplicate left behind.
  const staleSecrets = [...existingSecrets].filter((name) => !localSecretNames.has(name));
  const staleVariables = [...existingVariables.keys()].filter(
    (name) => !localVariableNames.has(name),
  );
  const crossKindDuplicates = new Set<string>([
    ...staleSecrets.filter((name) => localVariableNames.has(name)),
    ...staleVariables.filter((name) => localSecretNames.has(name)),
  ]);
  const deleteTotal = staleSecrets.length + staleVariables.length;

  let deleted = 0;

  if (deleteTotal > 0) {
    console.log('');
    console.log(`Pruning ${deleteTotal} stale item(s) from GitHub...`);
    if (crossKindDuplicates.size > 0) {
      console.log(
        `  (${crossKindDuplicates.size} of these are cross-kind duplicates from an older setup:infra version)`,
      );
    }

    for (const name of staleSecrets) {
      try {
        await deleteSecret(token, repositoryFullName, environment, name);
        deleted += 1;
        const note = crossKindDuplicates.has(name) ? ' (now a variable)' : '';
        console.log(`  [deleted]  secret ${name}${note}`);
      } catch (deleteError) {
        const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
        console.error(`  [error]    secret ${name}: ${msg}`);
      }
    }

    for (const name of staleVariables) {
      try {
        await deleteVariable(token, repositoryFullName, environment, name);
        deleted += 1;
        const note = crossKindDuplicates.has(name) ? ' (now a secret)' : '';
        console.log(`  [deleted]  variable ${name}${note}`);
      } catch (deleteError) {
        const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
        console.error(`  [error]    variable ${name}: ${msg}`);
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  console.log('');
  console.log(
    `Done. Pushed ${pushed}, skipped ${skipped}, deleted ${deleted} in ${formatDuration(totalDuration)}.`,
  );
  console.log(`Verify: SKIP_GITHUB_ENV=1 CONFIG=${environment} pnpm validate:github-env`);

  return { pushed, skipped, deleted };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: pnpm github:sync <environment> [--dry-run] [--no-create]');
    console.log('       pnpm github:sync --all [--dry-run]');
    process.exit(0);
  }

  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const skipCreate = argv.includes('--no-create');
  const env = argv.find((a) => !a.startsWith('--') && a !== '-n');

  if (!env) {
    console.error('Missing required argument: <environment>');
    console.error('Usage: pnpm github:sync <environment> [--dry-run] [--no-create]');
    process.exit(2);
  }

  await syncEnvironmentToGitHub({ environment: env, dryRun, skipCreate });
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
