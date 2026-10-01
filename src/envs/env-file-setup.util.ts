/**
 * Helpers for setup:infra providers whose inputs live in `.env.<environment>` rather than
 * `.setup/.setup-credentials`.
 */
import * as logger from '@setup/common/logger.js';
import { SetupAbort } from '@setup/common/setup-error.js';
import {
  createReadline,
  isAssumeYes,
  isForce,
  question,
  questionHidden,
} from '@setup/common/prompts.js';
import { isSecretFilled } from '@setup/common/secrets.js';
import type { SetupConfig, SetupState } from '@setup/common/types.js';
import { readEnvFileValue, upsertEnvFileValue } from './read-env-file.js';

/** Default environment from config (`isDefault` flag, else first listed). */
export function resolveDefaultEnvironmentName(config: SetupConfig): string {
  return (
    config.environments.find((environment) => environment.isDefault)?.name ??
    config.environments[0]?.name ??
    'development'
  );
}

/** OAuth app display name: `clinozy-be-development` for dev, `clinozy-be` for production. */
export function oauthAppDisplayName(projectName: string, environmentName: string): string {
  return environmentName === 'production' ? projectName : `${projectName}-${environmentName}`;
}

/**
 * The deployment's public **backend** (API) origin for an env — the host webhooks and the API
 * base URL resolve against (`<origin>/api/v1/...`). Read from `config.app.frontendUrl` (legacy
 * field name; it holds the API origin, which in local dev equals the dev server on
 * `localhost:3000`). The SPA's own origin is {@link frontendOriginForEnvironment} (`frontend.url`)
 * — OAuth redirect URIs resolve against that one, see {@link oauthCallbackUrl}.
 * Development falls back to `http://localhost:3000`.
 */
export function backendOriginForEnvironment(config: SetupConfig, environmentName: string): string {
  const configured = config.app.frontendUrl[environmentName];
  if (configured && configured.trim().length > 0) return configured.trim();
  if (environmentName === 'development') return 'http://localhost:3000';
  return '';
}

/**
 * The public API base URL to bake into an environment's OpenAPI `servers` (per-env Postman
 * collection / Scalar doc). Prefers the configured backend origin (`app.frontendUrl.<env>`, or
 * localhost for development), then the deployed Railway URL from state (custom domain → service
 * URL). Returns '' when no URL is known yet (e.g. production before a domain is set) — callers then
 * skip the server override and the doc keeps the default localhost server.
 */
export function resolveEnvironmentApiBaseUrl(
  config: SetupConfig,
  state: SetupState,
  environmentName: string,
): string {
  const configured = backendOriginForEnvironment(config, environmentName);
  if (configured) return configured;
  const services = [
    ...Object.values(state.railway?.environments?.[environmentName]?.services ?? {}),
    ...Object.values(state.railway?.services ?? {}),
  ];
  for (const service of services) {
    const domain = service.customDomain?.domain;
    if (domain) return `https://${domain.replace(/^https?:\/\//, '')}`;
  }
  for (const service of services) {
    if (service.url) return service.url.startsWith('http') ? service.url : `https://${service.url}`;
  }
  return '';
}

/**
 * OAuth redirect URI for a provider: the SPA's provider-specific landing page,
 * `<frontend origin>/callback/<provider>` (clinozy-be's `OAUTH_<PROVIDER>_REDIRECT_URI` contract).
 * The browser lands there with `code`+`state` and the SPA forwards them to the API's
 * `GET /api/v1/auth/oauth/<provider>/callback`, which brokers the token exchange (the client
 * secret never reaches the browser). That API route answers with JSON, not a redirect, so it must
 * NOT be registered as the redirect URI. Returns '' when the frontend origin is unknown
 * (`frontend.url.<env>` unset outside development).
 */
export function oauthCallbackUrl(
  config: SetupConfig,
  environmentName: string,
  provider: 'google' | 'github',
): string {
  const origin = frontendOriginForEnvironment(config, environmentName).replace(/\/+$/, '');
  return origin ? `${origin}/callback/${provider}` : '';
}

/**
 * Product-level name for resources SHARED by backend + frontend (PostHog project, Turnstile
 * widget). Defaults to `project.name` when `product` is unset (preserves backend-centric naming).
 */
export function productName(config: SetupConfig): string {
  return config.product?.name ?? config.project.name;
}

/** Shared-resource name for an env: `<product>-<env>` (e.g. `clinozy-development`, `clinozy-production`). */
export function productResourceName(config: SetupConfig, environmentName: string): string {
  return `${productName(config)}-${environmentName}`;
}

/**
 * The frontend (clinozy-fe) origin for an env, from `config.frontend.url`. Development falls back to
 * the Vite default (`http://localhost:5173`); other envs return '' when unset.
 */
export function frontendOriginForEnvironment(config: SetupConfig, environmentName: string): string {
  const configured = config.frontend?.url?.[environmentName];
  if (configured && configured.trim().length > 0) return configured.trim();
  if (environmentName === 'development') return 'http://localhost:5173';
  return '';
}

export function everyEnvironmentHasEnvKeys(config: SetupConfig, keys: string[]): boolean {
  return config.environments.every((environment) =>
    keys.every((key) => isSecretFilled(readEnvFileValue(environment.name, key))),
  );
}

/** One credential the collector asks for via stdin and writes to `.env.<environment>`. */
export interface EnvCredentialField {
  /** Env-file key, e.g. `OAUTH_GOOGLE_CLIENT_ID`. */
  key: string;
  /** Human label shown at the prompt. */
  label: string;
  /** Mask input (password-style) — use for secrets. */
  secret?: boolean;
  /** Computed default offered at the prompt (e.g. a redirect URI). */
  defaultValue?: (config: SetupConfig, environmentName: string) => string;
}

export interface CollectEnvCredentialsOptions {
  providerName: string;
  fields: EnvCredentialField[];
  /**
   * `per-environment` (default): prompt for every enabled environment (separate apps/keys).
   * `account`: prompt once and write the same value to every enabled environment.
   */
  scope?: 'per-environment' | 'account';
  /** Subset of `config.environments` to collect for (defaults to all). */
  environmentNames?: string[];
  /** When true, skip the per-environment continue/skip/abort gate (caller already gated). */
  skipEnvironmentGate?: boolean;
}

function resolveTargetEnvironmentNames(
  config: SetupConfig,
  options: CollectEnvCredentialsOptions,
): string[] {
  const configured = config.environments.map((environment) => environment.name);
  const requested = options.environmentNames ?? configured;
  return requested.filter((name) => configured.includes(name));
}

export type EnvironmentCollectionDecision = 'continue' | 'skip' | 'abort';

export interface CollectEnvCredentialsResult {
  completedEnvironments: string[];
  skippedEnvironments: string[];
  aborted: boolean;
}

/** Parse stdin for per-environment continue / skip / abort (exported for unit tests). */
export function parseEnvironmentCollectionDecision(
  answer: string,
): EnvironmentCollectionDecision | null {
  const normalized = answer.trim().toLowerCase();
  if (['c', 'continue', 'y', 'yes'].includes(normalized)) return 'continue';
  if (['s', 'skip'].includes(normalized)) return 'skip';
  if (['a', 'abort', 'q', 'quit', 'exit'].includes(normalized)) return 'abort';
  return null;
}

function environmentHasAllFields(environmentName: string, fields: EnvCredentialField[]): boolean {
  return fields.every((field) => isSecretFilled(readEnvFileValue(environmentName, field.key)));
}

/**
 * True when the run cannot (or should not) prompt: `--yes` non-interactive mode, or no TTY
 * on stdin (piped / CI / agent). In this mode guide-service values are resolved from the
 * environment instead of stdin, so the run never blocks.
 */
export function isNonInteractiveRun(): boolean {
  return isAssumeYes() || !process.stdin.isTTY;
}

/**
 * Resolve a guide field's value non-interactively from the environment. Supports a
 * per-environment override (`KEY__<env>`, e.g. `STRIPE_SECRET_KEY__production`) and a shared
 * fallback (`KEY`). Pure — `env` is injectable for tests. Returns `undefined` when neither is set,
 * so an absent value leaves whatever is already on disk untouched (idempotent).
 */
export function resolveNonInteractiveFieldValue(
  key: string,
  environmentName: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const perEnv = env[`${key}__${environmentName}`]?.trim();
  if (perEnv) return perEnv;
  const shared = env[key]?.trim();
  if (shared) return shared;
  return undefined;
}

/**
 * Default choice for the per-environment gate: keep an already-configured env (skip)
 * unless `--force` is set, which re-collects it. Pure (testable).
 */
export function defaultCollectionDecision(alreadyConfigured: boolean, force: boolean): 'c' | 's' {
  if (force) return 'c';
  return alreadyConfigured ? 's' : 'c';
}

async function promptEnvironmentCollectionDecision(
  environmentName: string,
  options: { alreadyConfigured: boolean },
): Promise<EnvironmentCollectionDecision> {
  const readline = createReadline();
  const hint = options.alreadyConfigured ? ' — already configured in .env file' : '';
  try {
    while (true) {
      const answer = await question(
        readline,
        `  Configure "${environmentName}"${hint}? (c)ontinue / (s)kip / (a)bort`,
        defaultCollectionDecision(options.alreadyConfigured, isForce()),
      );
      const decision = parseEnvironmentCollectionDecision(answer);
      if (decision) return decision;
      logger.warn('  Please answer with c (continue), s (skip), or a (abort).');
    }
  } finally {
    readline.close();
  }
}

async function promptField(field: EnvCredentialField, defaultValue: string): Promise<string> {
  if (field.secret) {
    const hint = ' (Enter to keep current)';
    return questionHidden(`  ${field.label}${hint}: `);
  }
  const readline = createReadline();
  try {
    return await question(readline, `  ${field.label}`, defaultValue);
  } finally {
    readline.close();
  }
}

/**
 * Interactively collect a validate-only provider's credentials from stdin and write them into
 * `.env.<environment>` for every enabled environment in `config.environments`.
 *
 * @remarks
 * **Inputs come from stdin only** — never read from the env file as a source. Secrets are
 * masked. An empty answer keeps whatever is already on disk (idempotent re-runs). For
 * `account` scope the prompt runs once and the value is written to every environment; for
 * `per-environment` scope each environment is prompted separately (e.g. separate OAuth apps).
 * **Side effects:** writes/creates `.env.<environment>` via `upsertEnvFileValue`. The guide for
 * *where/what to create* is printed by the provider's step instructions before this runs.
 * Each environment is gated with continue / skip / abort so you can configure one env at a time.
 */
export async function collectEnvCredentials(
  config: SetupConfig,
  options: CollectEnvCredentialsOptions,
): Promise<CollectEnvCredentialsResult> {
  const { providerName, fields, scope = 'per-environment', skipEnvironmentGate = false } = options;
  const environments = resolveTargetEnvironmentNames(config, options);
  const completedEnvironments: string[] = [];
  const skippedEnvironments: string[] = [];
  const nonInteractive = isNonInteractiveRun();
  logger.blank();
  if (nonInteractive) {
    logger.info(
      `Reading ${providerName} credentials from the environment (non-interactive): set KEY or KEY__<env>.`,
    );
  } else if (!skipEnvironmentGate && environments.length > 1) {
    logger.info(
      `Enter ${providerName} credentials per environment (c=configure, s=skip env, a=abort step):`,
    );
  } else {
    logger.info(`Enter ${providerName} credentials (press Enter to keep the current value):`);
  }

  // Non-interactive: pull from the environment (never prompt). Interactive: prompt via stdin.
  const collectFieldValue = async (
    field: EnvCredentialField,
    environmentName: string,
  ): Promise<string> => {
    if (nonInteractive) {
      return resolveNonInteractiveFieldValue(field.key, environmentName) ?? '';
    }
    const defaultValue = field.defaultValue?.(config, environmentName) ?? '';
    return promptField(field, defaultValue);
  };

  const gateEnvironment = async (
    environmentName: string,
  ): Promise<EnvironmentCollectionDecision> => {
    if (nonInteractive || skipEnvironmentGate || environments.length <= 1) return 'continue';
    return promptEnvironmentCollectionDecision(environmentName, {
      alreadyConfigured: environmentHasAllFields(environmentName, fields),
    });
  };

  if (scope === 'account') {
    const accountEnv = environments[0] ?? resolveDefaultEnvironmentName(config);
    const collected: Array<[string, string]> = [];
    for (const field of fields) {
      const value = await collectFieldValue(field, accountEnv);
      if (value) collected.push([field.key, value]);
    }
    for (const environmentName of environments) {
      const decision = await gateEnvironment(environmentName);
      if (decision === 'abort') {
        return { completedEnvironments, skippedEnvironments, aborted: true };
      }
      if (decision === 'skip') {
        skippedEnvironments.push(environmentName);
        continue;
      }
      for (const [key, value] of collected) {
        upsertEnvFileValue(environmentName, key, value);
      }
      completedEnvironments.push(environmentName);
    }
    return { completedEnvironments, skippedEnvironments, aborted: false };
  }

  for (const environmentName of environments) {
    const decision = await gateEnvironment(environmentName);
    if (decision === 'abort') {
      return { completedEnvironments, skippedEnvironments, aborted: true };
    }
    if (decision === 'skip') {
      skippedEnvironments.push(environmentName);
      continue;
    }
    logger.info(`  --- ${environmentName} (.env.${environmentName}) ---`);
    for (const field of fields) {
      const value = await collectFieldValue(field, environmentName);
      if (value) upsertEnvFileValue(environmentName, field.key, value);
    }
    completedEnvironments.push(environmentName);
  }
  return { completedEnvironments, skippedEnvironments, aborted: false };
}

/** Throw {@link SetupAbort} when the user chose abort during per-environment collection. */
export function assertCredentialCollectionNotAborted(result: CollectEnvCredentialsResult): void {
  if (result.aborted) {
    throw new SetupAbort('Credential collection aborted.');
  }
}

/** Human-readable summary of which environments were configured vs skipped. */
export function formatEnvCredentialCollectionSummary(
  providerName: string,
  result: CollectEnvCredentialsResult,
): string {
  const parts: string[] = [];
  if (result.completedEnvironments.length > 0) {
    parts.push(`configured: ${result.completedEnvironments.join(', ')}`);
  }
  if (result.skippedEnvironments.length > 0) {
    parts.push(`skipped: ${result.skippedEnvironments.join(', ')}`);
  }
  const detail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
  return `${providerName}${detail}`;
}
