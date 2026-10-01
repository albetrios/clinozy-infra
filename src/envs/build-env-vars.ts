/** Shared logic to build deploy environment variables (used by GitHub provider). */
import type {
  EnvironmentVariables,
  InfraProviderContext,
  SetupConfig,
  SetupSecrets,
  SetupState,
} from '@setup/common/types.js';
import { getInfraProviders } from '@setup/infra/providers/index.js';
import {
  frontendOriginForEnvironment,
  oauthCallbackUrl,
  productName,
  scalarSlugForEnvironment,
} from '@setup/envs/env-file-setup.util.js';
import { productNameOf } from '@setup/identity/identity.js';
import { readEnvFile } from '@setup/envs/read-env-file.js';

/** Defaults match .env.example (required at app runtime). */
const DEFAULT_AUDIT_RETENTION_DAYS = '90';
const DEFAULT_SESSION_RETENTION_DAYS = '30';

function pickPerEnvironmentString(
  perEnvironment: Record<string, string> | undefined,
  environmentName: string,
  defaultEnvironmentName: string | undefined,
): string {
  const explicit = perEnvironment?.[environmentName]?.trim();
  if (explicit) return explicit;
  if (defaultEnvironmentName && defaultEnvironmentName !== environmentName) {
    return perEnvironment?.[defaultEnvironmentName]?.trim() ?? '';
  }
  return '';
}

/** Short environment tag for key prefixes; any other environment uses its own name. */
const ENVIRONMENT_TAGS: Readonly<Record<string, string>> = {
  development: 'dev',
  production: 'prod',
};

/**
 * Backend keys that are pure functions of the product identity and the SPA origin.
 *
 * Derived on every run rather than pasted, so a rename (or a new environment) can never leave the
 * previous product's values behind — the first clinozy run found `REDIS_KEY_PREFIX=core:dev:` in
 * production, `WEBAUTHN_RP_NAME=YourApp`, `WEBAUTHN_RP_ID=localhost` in production, a stale
 * `SCALAR_SLUG` and a localhost OAuth redirect, all hand-kept. Keys whose source is unknown (no
 * `frontend.url` for the env, provider disabled) are omitted, and the exporter never blanks a key,
 * so an existing value survives until it can be derived.
 *
 * `OTEL_SERVICE_NAME` is deliberately NOT here: the backend names the API and the worker itself
 * (`<project>-api` / `<project>-worker`), and any env value would override both with one name.
 */
export function deriveIdentityVariables(
  environmentName: string,
  config: SetupConfig,
  secrets: SetupSecrets,
): Partial<EnvironmentVariables> {
  const namespace = productName(config);
  const variables: Partial<EnvironmentVariables> = {
    REDIS_KEY_PREFIX: `${namespace}:${ENVIRONMENT_TAGS[environmentName] ?? environmentName}:`,
    WEBAUTHN_RP_NAME: productNameOf(config.project.displayName, namespace),
  };

  const spaOrigin = frontendOriginForEnvironment(config, environmentName);
  if (spaOrigin) {
    try {
      variables.WEBAUTHN_RP_ID = new URL(spaOrigin).hostname;
    } catch {
      // An unparseable frontend.url is reported by `pnpm setup:infra:doctor`; leave the key alone.
    }
    if (config.providers.oauth.github.enabled) {
      variables.OAUTH_GITHUB_REDIRECT_URI = oauthCallbackUrl(config, environmentName, 'github');
    }
    if (config.providers.oauth.google.enabled) {
      variables.OAUTH_GOOGLE_REDIRECT_URI = oauthCallbackUrl(config, environmentName, 'google');
    }
  }

  if (config.providers.scalar.enabled) {
    variables.SCALAR_SLUG = scalarSlugForEnvironment(config, secrets, environmentName);
  }
  return variables;
}

/**
 * Build the `.env.<environment>` variable map for one environment.
 *
 * @remarks
 * **Composition:** baseline keys (config-derived: ports, NODE_ENV, rate limits, retention,
 * ALLOWED_ORIGINS from `app.allowedOrigins`, FRONTEND_URL from `frontend.url` — the SPA origin)
 * are set first, then each provider contributes its own slice
 * via `provider.toEnvironmentVariables()` — so adding a provider never touches this file. The
 * required-but-provisioned keys (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`) start as empty
 * defaults and are overwritten by their owning provider (Neon / Railway Redis / JWT) when
 * state is populated. **Side effects:** none (pure). Identity-bound keys (Redis prefix, passkey
 * RP id/name, OAuth redirect URIs, Scalar slug) come from {@link deriveIdentityVariables}. OAuth
 * client ids/secrets are intentionally NOT produced here — they live directly in `.env.<environment>`. Cloudflare Turnstile (CAPTCHA_*) and Stripe
 * (STRIPE_*) ARE produced here: their providers read keys from `.setup-credentials` and emit the
 * matching `.env.<environment>` slice via `toEnvironmentVariables()`.
 */
export function buildEnvironmentVariables(
  environmentName: string,
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
): EnvironmentVariables {
  const environment = config.environments.find((env) => env.name === environmentName);
  const defaultEnvironment =
    config.environments.find((env) => env.isDefault)?.name ?? config.environments[0]?.name;

  const allowedOrigins = pickPerEnvironmentString(
    config.app.allowedOrigins,
    environmentName,
    defaultEnvironment,
  );
  // The backend reads FRONTEND_URL as the SPA origin (password-reset and invite links, the OAuth
  // redirect fallback, the WebAuthn expected origin), so it comes from `frontend.url` — never from
  // `app.frontendUrl`, which despite its name holds the API origin. No fallback to another
  // environment: a production run must not inherit the development SPA URL.
  const frontendUrl = frontendOriginForEnvironment(config, environmentName);

  // Baseline: config-derived keys + required-key defaults (providers overwrite the provisioned ones).
  const variables: EnvironmentVariables = {
    PORT: String(config.app.port),
    HTTP_BIND_HOST: config.app.host,
    NODE_ENV: environment?.nodeEnvironment ?? 'development',
    LOG_LEVEL: environment?.nodeEnvironment === 'production' ? 'info' : 'debug',
    DATABASE_URL: '',
    REDIS_URL: '',
    JWT_SECRET: '',
    ALLOWED_ORIGINS: allowedOrigins,
    RATE_LIMIT_MAX: String(config.app.rateLimitMax[environmentName] ?? 100),
    RATE_LIMIT_WINDOW_MS: String(config.app.rateLimitWindowMs),
    METRICS_ENABLED: 'false',
    AUDIT_RETENTION_DAYS: DEFAULT_AUDIT_RETENTION_DAYS,
    AUTH_SESSION_RETENTION_DAYS: DEFAULT_SESSION_RETENTION_DAYS,
  };
  if (frontendUrl) {
    variables.FRONTEND_URL = frontendUrl;
  }
  Object.assign(variables, deriveIdentityVariables(environmentName, config, secrets));

  // Each provider owns its own `.env.<environment>` slice (Neon → DATABASE_URL, AWS → S3_*, …).
  const context: InfraProviderContext = {
    config,
    secrets,
    state,
    environments: config.environments.map((env) => env.name),
    applyStateUpdates: () => {},
  };
  for (const provider of getInfraProviders()) {
    Object.assign(variables, provider.toEnvironmentVariables?.(context, environmentName) ?? {});
  }

  return variables;
}

/**
 * The fully-resolved env for one environment: the computed {@link buildEnvironmentVariables} view
 * with the on-disk `.env.<environment>` file overlaid on top. The file is the source of truth for
 * what is actually persisted, so this surfaces keys written directly to it (user-entered
 * `STRIPE_*`/`OAUTH_*`, provider upserts like `CAPTCHA_*`/`POSTMAN_WORKSPACE_ID`) that never flow
 * through a provider's `toEnvironmentVariables` hook. Use this — not `buildEnvironmentVariables`
 * alone — when you need the complete picture (`setup:infra:output`, `--copy`, `setup:infra:frontend`).
 */
export function resolveEnvironmentVariables(
  environmentName: string,
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
): Record<string, string> {
  const computed = buildEnvironmentVariables(environmentName, config, secrets, state);
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(computed)) {
    if (value !== undefined) merged[key] = String(value);
  }
  return { ...merged, ...readEnvFile(environmentName) };
}
