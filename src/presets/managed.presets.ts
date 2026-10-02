/**
 * Managed presets — thin catalog entries wrapping the retained API-orchestrating
 * providers (the "client libs"). Each declares its env-var outputs so docs, doctor,
 * and `.env.example` generation can enumerate every service without running it.
 *
 * The heavy provisioning + lifecycle code stays in each retained `.provider.ts`
 * (they call live APIs — Neon/Railway/AWS/Cloudflare/Sentry/PostHog — and implement
 * inspectRemote/check/deleteInstructions/detectRemote). Splitting API calls from
 * wiring per-provider can follow later, ideally with integration testing.
 */
import { setupAwsProvider } from '@setup/infra/providers/setup-aws/setup-aws.provider.js';
import { setupCloudflareTurnstileProvider } from '@setup/infra/providers/setup-cloudflare-turnstile/setup-cloudflare-turnstile.provider.js';
import { setupGithubProvider } from '@setup/infra/providers/setup-github/setup-github.provider.js';
import { setupGithubAppWithOauthProvider } from '@setup/infra/providers/setup-github-app-with-oauth/setup-github-app-with-oauth.provider.js';
import { setupJwtProvider } from '@setup/infra/providers/setup-jwt/setup-jwt.provider.js';
import { setupNeonProvider } from '@setup/infra/providers/setup-neon/setup-neon.provider.js';
import { setupNetlifyProvider } from '@setup/infra/providers/setup-netlify/setup-netlify.provider.js';
import { setupPostmanProvider } from '@setup/infra/providers/setup-postman/setup-postman.provider.js';
import { setupPosthogProvider } from '@setup/infra/providers/setup-posthog/setup-posthog.provider.js';
import { setupRailwayProvider } from '@setup/infra/providers/setup-railway/setup-railway.provider.js';
import { setupRailwayRedisProvider } from '@setup/infra/providers/setup-railway-redis/setup-railway-redis.provider.js';
import { setupScalarProvider } from '@setup/infra/providers/setup-scalar/setup-scalar.provider.js';
import { setupSentryProvider } from '@setup/infra/providers/setup-sentry/setup-sentry.provider.js';
import type { ManagedPreset } from './types.js';

export const neonPreset: ManagedPreset = {
  kind: 'managed',
  key: 'neon',
  name: 'Neon Postgres',
  provider: setupNeonProvider,
  credentials: ['NEON_API_KEY'],
  dashboard: { url: 'https://console.neon.tech/app/settings/api-keys', label: 'Neon → API keys' },
  outputs: [
    { key: 'DATABASE_URL', description: 'Pooled Postgres connection string' },
    {
      key: 'DATABASE_MIGRATION_URL',
      description:
        'Direct connection for migrations — the migrator login, or the owner until it exists',
    },
    { key: 'DATABASE_MAINTENANCE_URL', description: 'Pooled connection as the maintenance role' },
    {
      key: 'MONTHLY_DATABASE_RESTORE_DRILL_NEON_API_KEY',
      description: 'Neon API key for the scheduled restore drill (= NEON_API_KEY)',
    },
  ],
};

export const awsPreset: ManagedPreset = {
  kind: 'managed',
  key: 'aws',
  name: 'AWS S3',
  provider: setupAwsProvider,
  credentials: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  dashboard: { url: 'https://console.aws.amazon.com/iam/', label: 'AWS → IAM' },
  outputs: [
    { key: 'S3_BUCKET' },
    { key: 'S3_REGION' },
    { key: 'S3_ACCESS_KEY_ID' },
    { key: 'S3_SECRET_ACCESS_KEY' },
  ],
};

export const sentryPreset: ManagedPreset = {
  kind: 'managed',
  key: 'sentry',
  name: 'Sentry',
  provider: setupSentryProvider,
  credentials: ['SENTRY_AUTH_TOKEN'],
  dashboard: {
    url: 'https://sentry.io/settings/account/api/auth-tokens/',
    label: 'Sentry → auth tokens',
  },
  outputs: [
    { key: 'SENTRY_DSN' },
    { key: 'SENTRY_ENVIRONMENT' },
    { key: 'SENTRY_FRONTEND_DSN' },
    { key: 'SENTRY_TRACES_SAMPLE_RATE' },
    { key: 'SENTRY_PROFILE_SAMPLE_RATE' },
  ],
};

export const jwtPreset: ManagedPreset = {
  kind: 'managed',
  key: 'jwt',
  name: 'JWT secrets',
  provider: setupJwtProvider,
  // Generated locally — no account, no key to fetch.
  outputs: [
    { key: 'JWT_SECRET' },
    { key: 'JWT_PRIVATE_KEY' },
    { key: 'JWT_PUBLIC_KEY' },
    { key: 'JWT_SIGNING_KID' },
    { key: 'SECRETS_ENCRYPTION_KEY' },
  ],
};

export const githubAppWithOauthPreset: ManagedPreset = {
  kind: 'managed',
  key: 'github-app-with-oauth',
  name: 'GitHub App (sign-in)',
  provider: setupGithubAppWithOauthProvider,
  perEnv: true,
  dashboard: {
    url: 'https://github.com/settings/apps',
    label: 'GitHub → developer settings → Apps',
  },
  steps: [
    'Open GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.',
    'Set the Callback URL to OAUTH_GITHUB_REDIRECT_URI from your .env.<env>, and enable user authorization (OAuth).',
    'Copy the Client ID and generate a Client secret.',
    'Paste OAUTH_GITHUB_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI into .env.<env>.',
  ],
  outputs: [
    { key: 'OAUTH_GITHUB_CLIENT_ID' },
    { key: 'OAUTH_GITHUB_CLIENT_SECRET' },
    { key: 'OAUTH_GITHUB_REDIRECT_URI' },
  ],
};

export const posthogPreset: ManagedPreset = {
  kind: 'managed',
  key: 'posthog',
  name: 'PostHog',
  provider: setupPosthogProvider,
  credentials: ['POSTHOG_PERSONAL_API_KEY'],
  dashboard: {
    url: 'https://us.posthog.com/settings/user-api-keys',
    label: 'PostHog → personal API keys',
  },
  outputs: [{ key: 'POSTHOG_KEY' }, { key: 'POSTHOG_HOST' }],
};

export const turnstilePreset: ManagedPreset = {
  kind: 'managed',
  key: 'turnstile',
  name: 'Cloudflare Turnstile',
  provider: setupCloudflareTurnstileProvider,
  credentials: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
  dashboard: {
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    label: 'Cloudflare → API tokens',
  },
  outputs: [{ key: 'CAPTCHA_PROVIDER' }, { key: 'CAPTCHA_SITE_KEY' }, { key: 'CAPTCHA_SECRET' }],
};

export const railwayPreset: ManagedPreset = {
  kind: 'managed',
  key: 'railway',
  name: 'Railway',
  provider: setupRailwayProvider,
  credentials: ['RAILWAY_API_TOKEN'],
  dashboard: { url: 'https://railway.app/account/tokens', label: 'Railway → account → tokens' },
  outputs: [{ key: 'RAILWAY_TOKEN', description: 'Per-environment project-scoped deploy token' }],
};

export const railwayRedisPreset: ManagedPreset = {
  kind: 'managed',
  key: 'railway-redis',
  name: 'Railway Redis',
  provider: setupRailwayRedisProvider,
  credentials: ['RAILWAY_API_TOKEN'],
  dashboard: { url: 'https://railway.app/account/tokens', label: 'Railway → account → tokens' },
  outputs: [{ key: 'REDIS_URL', description: 'Internal Railway redis URL' }],
};

export const githubPreset: ManagedPreset = {
  kind: 'managed',
  key: 'github',
  name: 'GitHub',
  provider: setupGithubProvider,
  credentials: ['GITHUB_TOKEN'],
  dashboard: {
    url: 'https://github.com/settings/tokens',
    label: 'GitHub → personal access tokens',
  },
  // Env-scoped secrets/variables are synced by the GitHub sync step. The one value written here is
  // the release token: GitHub has no API to mint a personal token, so GITHUB_TOKEN is the source.
  outputs: [
    {
      key: 'RELEASE_PLEASE_TOKEN',
      description:
        'GitHub token release-please uses so a release triggers the deploy (= GITHUB_TOKEN)',
    },
  ],
};

export const postmanPreset: ManagedPreset = {
  kind: 'managed',
  key: 'postman',
  name: 'Postman',
  provider: setupPostmanProvider,
  credentials: ['POSTMAN_API_KEY'],
  dashboard: { url: 'https://go.postman.co/settings/me/api-keys', label: 'Postman → API keys' },
  outputs: [{ key: 'POSTMAN_WORKSPACE_ID' }],
};

export const scalarPreset: ManagedPreset = {
  kind: 'managed',
  key: 'scalar',
  name: 'Scalar',
  provider: setupScalarProvider,
  credentials: ['SCALAR_API_KEY'],
  dashboard: { url: 'https://dashboard.scalar.com', label: 'Scalar → dashboard' },
  // Publishes an OpenAPI doc per env; the backend's own docs workflow publishes to the same slug.
  outputs: [{ key: 'SCALAR_SLUG', description: 'Scalar Registry slug, `<project>-<env>`' }],
};

export const netlifyPreset: ManagedPreset = {
  kind: 'managed',
  key: 'netlify',
  name: 'Netlify',
  provider: setupNetlifyProvider,
  credentials: ['NETLIFY_AUTH_TOKEN'],
  dashboard: {
    url: 'https://app.netlify.com/user/applications#personal-access-tokens',
    label: 'Netlify → personal access tokens',
  },
  // Frontend-only: NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN are written to the frontend env by
  // frontend-env-keys.ts, never to the backend env (which is what `outputs` describes).
  outputs: [],
};
