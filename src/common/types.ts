import type { z } from 'zod';
import type { setupConfigSchema } from './config.js';
import type { setupSecretsSchema } from './secrets.js';
import type { setupStateSchema } from './state.js';
import type { StepDescriptor } from './interactive-step.js';

export type SetupConfig = z.infer<typeof setupConfigSchema>;
export type SetupSecrets = z.infer<typeof setupSecretsSchema>;
export type SetupState = z.infer<typeof setupStateSchema>;

export type SetupCommand = 'provision' | 'check' | 'status' | 'update' | 'destroy';

export type EnvironmentName = string;

export interface ProviderContext {
  config: SetupConfig;
  secrets: SetupSecrets;
  state: SetupState;
  environments: string[];
}

export interface ProviderResult {
  success: boolean;
  message: string;
  stateUpdates?: Partial<SetupState>;
}

export interface HealthCheckResult {
  provider: string;
  environment?: string;
  healthy: boolean;
  message: string;
}

export interface EnvironmentVariables {
  PORT: string;
  HTTP_BIND_HOST: string;
  NODE_ENV: string;
  LOG_LEVEL: string;
  DATABASE_URL: string;
  DATABASE_MIGRATION_URL?: string;
  /** RLS-subject maintenance pool (`<project>_maintenance`) — set once the backend's migrations ran. */
  DATABASE_MAINTENANCE_URL?: string;
  REDIS_URL: string;
  REDIS_BULLMQ_URL?: string;
  /** `<product>:<env tag>:` — namespaces every Redis key (derived; see deriveIdentityVariables). */
  REDIS_KEY_PREFIX?: string;
  JWT_SECRET: string;
  JWT_PRIVATE_KEY?: string;
  JWT_PUBLIC_KEY?: string;
  JWT_SIGNING_KID?: string;
  SECRETS_ENCRYPTION_KEY?: string;
  ALLOWED_ORIGINS: string;
  /** SPA origin (`frontend.url.<env>`) — the backend builds reset/invite links and the WebAuthn origin from it. */
  FRONTEND_URL?: string;
  /** Passkey relying-party id — the SPA's hostname (derived from `frontend.url.<env>`). */
  WEBAUTHN_RP_ID?: string;
  /** Passkey relying-party name shown in the authenticator prompt — the product name. */
  WEBAUTHN_RP_NAME?: string;
  RATE_LIMIT_MAX: string;
  RATE_LIMIT_WINDOW_MS: string;
  METRICS_ENABLED?: string;
  AUDIT_RETENTION_DAYS: string;
  AUTH_SESSION_RETENTION_DAYS: string;
  TOMBSTONE_RETENTION_DAYS?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM_ADDRESS?: string;
  EMAIL_FROM_NAME?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  OAUTH_GOOGLE_REDIRECT_URI?: string;
  OAUTH_GITHUB_CLIENT_ID?: string;
  OAUTH_GITHUB_CLIENT_SECRET?: string;
  OAUTH_GITHUB_REDIRECT_URI?: string;
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  CAPTCHA_PROVIDER?: string;
  CAPTCHA_SITE_KEY?: string;
  CAPTCHA_SECRET?: string;
  SENTRY_DSN?: string;
  SENTRY_FRONTEND_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  SENTRY_PROFILE_SAMPLE_RATE?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  RAILWAY_TOKEN?: string;
  RAILWAY_SERVICE_ID?: string;
  RAILWAY_WORKER_SERVICE_ID?: string;
  POSTMAN_WORKSPACE_ID?: string;
  /** Scalar Registry slug the backend's own docs publish targets (`<base>-<env>`). */
  SCALAR_SLUG?: string;
  /** GitHub token release-please uses so a release can trigger the deploy workflow (= GITHUB_TOKEN). */
  RELEASE_PLEASE_TOKEN?: string;
  /** Neon API key for the scheduled restore drill (= the setup NEON_API_KEY). */
  MONTHLY_DATABASE_RESTORE_DRILL_NEON_API_KEY?: string;
}

export interface GuideStep {
  stepNumber: number;
  totalSteps: number;
  providerName: string;
  secretsKeys: string[];
  browserUrl: string;
  instructions: string[];
}

// ─── InfraProvider — uniform third-party provider contract ──────────────────
//
// Every third-party provider in `providers/setup-<name>/` exports a single
// `setup<Name>Provider: InfraProvider` const. The orchestrator iterates the
// registry in `providers/index.ts` and treats every provider the same way:
// preview → settings-review → detect-existing → build interactive step →
// check → destroy. Adding a third party = drop a folder + register in the
// index.

export interface InfraProviderContext {
  config: SetupConfig;
  secrets: SetupSecrets;
  state: SetupState;
  environments: string[];
  applyStateUpdates: (updates: Partial<SetupState>) => void;
}

export interface InfraProviderPreview {
  detail: string;
  url: string;
  configKey: string;
}

export interface InfraProviderSettingsEntry {
  bucket: 'resource' | 'extra';
  provider: string;
  detail: string;
}

export interface InfraProviderDeleteInstruction {
  /** Display name for the entry in the manual-delete guide. */
  provider: string;
  /** Dashboard URL where the user can delete the resources. */
  dashboardUrl: string;
  /** Optional list of step-by-step actions (rendered as bullets). */
  steps?: string[];
  /**
   * Resources currently recorded in the run state that the user must
   * delete in the dashboard. Empty array is allowed (we still print the URL
   * so the user can audit). Identifier is whatever the dashboard shows
   * (project ID, bucket name, etc.).
   */
  resources: Array<{ label: string; identifier: string }>;
}

export interface InfraProviderExistingResource {
  provider: string;
  detail: string;
}

/**
 * The organization / project / environment names a provider operates on — exactly as the
 * provider's own code derives them (all from `setup.config.json`, never hardcoded).
 * Surfaced as columns by `setup:infra:plan`. `—` (omitted field) = not applicable.
 */
export interface InfraProviderDescription {
  /** Org / owner / workspace name (e.g. Sentry org, GitHub owner). */
  organization?: string;
  /** Project / repo / bucket-prefix / slug name. */
  project?: string;
  /** Per-environment resource names (or the env names when 1:1). */
  environments?: string[];
  /** Service names this provider deploys (e.g. Railway api/worker, Railway Redis redis). */
  services?: string[];
  /**
   * Optional grouping label. Providers sharing a `planGroup` are merged into one row in
   * `setup:infra:plan` (e.g. Railway server + Railway Redis → a single "Railway" line).
   */
  planGroup?: string;
}

/** One field compared between `setup.config.json` (expected) and the live provider (remote). */
export interface RemoteField {
  /** Field label, e.g. "project name", "branch (development)", "region", "organization". */
  label: string;
  /** Expected value from config (single source of truth). */
  expected: string;
  /** Value read from the provider API (`—` when absent). */
  remote: string;
  /** True when expected === remote. */
  matches: boolean;
  /** Marks a required prerequisite (e.g. organization) that setup will NOT create. */
  prerequisite?: boolean;
}

/** Result of a live remote inspection for one provider (see `inspectRemote`). */
export interface RemoteInspection {
  /** True when the provider's resource(s) exist at the provider's end. */
  present: boolean;
  /** Deep, field-by-field comparison of config vs remote. */
  fields: RemoteField[];
  /** Set when the check could not run (no token / unreachable / API error). Never throws. */
  error?: string;
}

export interface InfraProvider {
  /** Stable kebab-case key matching the folder name (e.g. 'neon'). */
  key: string;
  /** Human-readable name for logs and tables. */
  name: string;
  /** True when the provider should run for the current config + secrets. */
  isEnabled(context: InfraProviderContext): boolean;
  /** Reason shown when `isEnabled` returns false. */
  disabledReason(context: InfraProviderContext): string;
  /** Browser-guided preview metadata (used by `runPreview`). */
  preview?(context: InfraProviderContext): InfraProviderPreview | null;
  /** Settings-review entries (used by `displaySettingsReview`). */
  settingsReview?(context: InfraProviderContext): InfraProviderSettingsEntry[];
  /** Pre-existence detection (used by `checkForExistingResources`). */
  detectExisting?(context: InfraProviderContext): Promise<InfraProviderExistingResource[]>;
  /** Remote resource detection for state reconstruction (used by --reconstruct). */
  detectRemote?(context: InfraProviderContext): Promise<Record<string, unknown>>;
  /**
   * Live remote inspection: does the resource exist at the provider, and does its config
   * match `setup.config.json` (field-by-field)? Powers `setup:infra:inspect` and
   * `setup:infra:plan --remote`. Must degrade gracefully (return `{ error }`, never throw).
   */
  inspectRemote?(context: InfraProviderContext): Promise<RemoteInspection>;
  /** Org / project / environment names this provider operates on (for `setup:infra:plan`). */
  describe?(context: InfraProviderContext): InfraProviderDescription;
  /**
   * The `.env.<environment>` keys this provider contributes for one environment. Composed by
   * `buildEnvironmentVariables()` — each provider owns its own slice (DATABASE_URL, S3_*, …)
   * instead of a central switch. Return `{}` (or omit the hook) when the provider creates no
   * runtime env vars (validate-only providers whose secrets are user-entered in the env file).
   */
  toEnvironmentVariables?(
    context: InfraProviderContext,
    environmentName: string,
  ): Partial<EnvironmentVariables>;
  /** Build the interactive step descriptor for the provision loop. */
  buildStep(context: InfraProviderContext): StepDescriptor<unknown>;
  /** Health check used by `runCheck`. Return true when not applicable. */
  check?(context: InfraProviderContext): Promise<boolean>;
  /**
   * Manual-delete guide. Returns the dashboard URL(s) and resource identifiers
   * the user must remove themselves. setup:infra never deletes resources —
   * `pnpm setup:infra --delete` only prints this guide.
   */
  deleteInstructions?(context: InfraProviderContext): InfraProviderDeleteInstruction[];
}
