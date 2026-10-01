/** Shared logic to build deploy environment variables (used by GitHub provider). */
import type {
  EnvironmentVariables,
  InfraProviderContext,
  SetupConfig,
  SetupSecrets,
  SetupState,
} from '@setup/common/types.js';
import { getInfraProviders } from '@setup/infra/providers/index.js';
import { frontendOriginForEnvironment } from '@setup/envs/env-file-setup.util.js';
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
 * state is populated. **Side effects:** none (pure). OAuth secrets are intentionally NOT produced
 * here — they live directly in `.env.<environment>`. Cloudflare Turnstile (CAPTCHA_*) and Stripe
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
