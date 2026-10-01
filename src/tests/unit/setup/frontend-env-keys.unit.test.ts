import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFrontendRoot, setTargetRoot } from '@setup/common/paths.js';
import {
  FRONTEND_ENV_KEY_MAPPINGS,
  FRONTEND_FALLBACK_HEADER,
  buildFrontendEnvContent,
  freshFrontendValues,
  frontendEnvFileName,
} from '@setup/envs/frontend-env-keys.js';
import type { SetupConfig, SetupSecrets, SetupState } from '@setup/common/types.js';

const disabledProviders = {
  neon: { enabled: false, region: 'r', pgVersion: 17, computeSize: { min: 0.25, max: 1 } },
  railwayRedis: { enabled: false },
  aws: { enabled: false, region: 'us-east-1', s3BucketPrefix: 'p', iamUserPrefix: 'p' },
  sentry: {
    enabled: false,
    organization: 'o',
    project: 'p',
    sampleRates: { development: { traces: 1, profile: 1 } },
  },
  resend: { enabled: false, fromAddress: '', fromName: '' },
  stripe: { enabled: false },
  oauth: { google: { enabled: false }, github: { enabled: false } },
  posthog: { enabled: true, region: 'us' as const },
  turnstile: { enabled: false },
  railway: { enabled: false },
  github: { enabled: false, repository: 'o/r' },
  postman: { enabled: false },
  scalar: { enabled: false },
};

const baseConfig = {
  project: { name: 'clinozy-be', displayName: 'clinozy-be', organization: 'albetrios' },
  product: { name: 'core' },
  frontend: { name: 'clinozy-fe', url: { development: 'http://localhost:5173' } },
  environments: [
    {
      name: 'development',
      label: 'Development',
      nodeEnvironment: 'development',
      deployBranch: 'dev',
      protected: true,
    },
  ],
  providers: disabledProviders,
  app: {
    port: 3000,
    host: '0.0.0.0',
    frontendUrl: { development: 'http://localhost:3000' },
    allowedOrigins: { development: 'http://localhost:5173' },
    rateLimitMax: { development: 100 },
    rateLimitWindowMs: 60_000,
  },
} as unknown as SetupConfig;

const emptySecrets = {} as SetupSecrets;

const stateWithPosthog: SetupState = {
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  posthog: {
    projectApiKeys: { development: 'phc_test_key' },
    host: 'https://us.i.posthog.com',
  },
};

describe('frontend env export (surgical)', () => {
  // Point both targets at throwaway dirs so freshFrontendValues() reads no real on-disk env files.
  let backendDir: string;
  let frontendDir: string;

  beforeEach(() => {
    backendDir = mkdtempSync(join(tmpdir(), 'clinozy-be-'));
    frontendDir = mkdtempSync(join(tmpdir(), 'clinozy-fe-'));
    setTargetRoot(backendDir);
    setFrontendRoot(frontendDir);
  });

  afterEach(() => {
    setTargetRoot(undefined);
    setFrontendRoot(undefined);
    rmSync(backendDir, { recursive: true, force: true });
    rmSync(frontendDir, { recursive: true, force: true });
  });

  it('names frontend env files .env.<environment> (clinozy-fe, no .fe suffix)', () => {
    expect(frontendEnvFileName('development')).toBe('.env.development');
    expect(frontendEnvFileName('production')).toBe('.env.production');
  });

  it('emits only resolved Vite keys onto the fallback header when clinozy-fe has no .env.example', () => {
    const fresh = freshFrontendValues('development', baseConfig, emptySecrets, stateWithPosthog);
    const content = buildFrontendEnvContent(`${FRONTEND_FALLBACK_HEADER}\n`, fresh);

    expect(content).toContain(FRONTEND_FALLBACK_HEADER);
    expect(content).toMatch(/VITE_POSTHOG_KEY=phc_/);
    expect(content).toContain('VITE_POSTHOG_HOST=https://us.i.posthog.com');
  });

  it('upserts onto an existing clinozy-fe env: overwrites mapped keys, preserves everything else', () => {
    const existing = [
      '# clinozy-fe env',
      'VITE_API_BASE_URL=https://api.example.com',
      'VITE_POSTHOG_KEY=',
      'VITE_POSTHOG_HOST=',
      'VITE_CAPTCHA_DISABLED=false',
      '',
    ].join('\n');

    const fresh = freshFrontendValues('development', baseConfig, emptySecrets, stateWithPosthog);
    const content = buildFrontendEnvContent(existing, fresh);

    // Mapped keys overwritten from resolved state.
    expect(content).toMatch(/VITE_POSTHOG_KEY=phc_/);
    expect(content).toContain('VITE_POSTHOG_HOST=https://us.i.posthog.com');
    // Custom + untouched keys and the comment are preserved byte-for-byte.
    expect(content).toContain('# clinozy-fe env');
    expect(content).toContain('VITE_API_BASE_URL=https://api.example.com');
    expect(content).toContain('VITE_CAPTCHA_DISABLED=false');
  });

  it('writes build-time SENTRY_ORG + SENTRY_PROJECT from config; never the auth token', () => {
    const existing = [
      'SENTRY_AUTH_TOKEN=',
      'SENTRY_ORG=',
      'SENTRY_PROJECT=',
      'VITE_POSTHOG_KEY=',
      '',
    ].join('\n');
    const sentryConfig = {
      ...baseConfig,
      providers: {
        ...disabledProviders,
        sentry: { ...disabledProviders.sentry, enabled: true, organization: 'albetrios-7j' },
      },
    } as unknown as SetupConfig;

    const fresh = freshFrontendValues('production', sentryConfig, emptySecrets, stateWithPosthog);
    const content = buildFrontendEnvContent(existing, fresh);

    expect(content).toContain('SENTRY_ORG=albetrios-7j'); // config.providers.sentry.organization
    expect(content).toContain('SENTRY_PROJECT=clinozy-fe'); // config.frontend.name
    // The secret half is NEVER emitted — its line stays blank.
    expect(content).not.toMatch(/SENTRY_AUTH_TOKEN=.+/);
  });

  it('exposes every mapped Vite key name for downstream consumers', () => {
    expect(FRONTEND_ENV_KEY_MAPPINGS.map((m) => m.vite)).toContain('VITE_POSTHOG_KEY');
  });
});
