/**
 * Config-derived backend env keys.
 *
 * FRONTEND_URL is the SPA origin; `app.frontendUrl` (legacy name) is the API origin. The backend
 * builds password-reset and invite links, the OAuth redirect fallback and the WebAuthn expected
 * origin from FRONTEND_URL. It used to be filled from `app.frontendUrl` — the API origin — and, with
 * no production value, inherited the development one, so production emails linked to localhost:3000.
 *
 * The identity-bound keys (Redis prefix, passkey RP id/name, OAuth redirect URIs, Scalar slug) are
 * derived the same way, so a rename can never leave the previous product's values behind.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFrontendRoot, setTargetRoot } from '@setup/common/paths.js';
import type { SetupConfig, SetupSecrets, SetupState } from '@setup/common/types.js';
import { buildEnvironmentVariables, deriveIdentityVariables } from '@setup/envs/build-env-vars.js';
import { buildConfig } from '@setup/infra/init-wizard.js';
import { downstreamEnvHints } from '@setup/railway/custom-domain-hints.js';

const state: SetupState = {
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** The wizard's real defaults: app.frontendUrl.production = https://api.example.com (the API). */
const base = (): SetupConfig =>
  buildConfig('acme-org', 'acme-be', 'Acme Backend', ['development', 'production']);

/** Providers off: these tests cover the config-derived baseline keys, not provider slices. */
const offline = (config: SetupConfig): SetupConfig => ({
  ...config,
  providers: Object.fromEntries(
    Object.entries(config.providers).map(([key, provider]) => [
      key,
      'enabled' in provider ? { ...provider, enabled: false } : provider,
    ]),
  ) as SetupConfig['providers'],
});

const withSpa = (url: Record<string, string>): SetupConfig => ({
  ...base(),
  frontend: { name: 'acme-fe', url },
});

describe('FRONTEND_URL in the backend env', () => {
  let backendDir = '';
  let frontendDir = '';
  beforeEach(() => {
    backendDir = mkdtempSync(join(tmpdir(), 'frontend-url-be-'));
    frontendDir = mkdtempSync(join(tmpdir(), 'frontend-url-fe-'));
    setTargetRoot(backendDir);
    setFrontendRoot(frontendDir);
  });
  afterEach(() => {
    rmSync(backendDir, { recursive: true, force: true });
    rmSync(frontendDir, { recursive: true, force: true });
    setTargetRoot(undefined);
    setFrontendRoot(undefined);
  });

  const frontendUrl = (environment: string, config: SetupConfig): string | undefined =>
    buildEnvironmentVariables(environment, offline(config), {} as SetupSecrets, state).FRONTEND_URL;

  it('is the SPA origin (frontend.url), never the API origin (app.frontendUrl)', () => {
    const config = withSpa({
      development: 'https://dev.app.acme.test',
      production: 'https://app.acme.test',
    });
    expect(config.app.frontendUrl.production).toBe('https://api.example.com');
    expect(frontendUrl('production', config)).toBe('https://app.acme.test');
    expect(frontendUrl('development', config)).toBe('https://dev.app.acme.test');
  });

  it('falls back to the Vite dev origin in development only', () => {
    const config = base();
    expect(frontendUrl('development', config)).toBe('http://localhost:5173');
    expect(frontendUrl('production', config)).toBeUndefined();
  });

  it('carries the identity-derived keys into the full backend env map', () => {
    const variables = buildEnvironmentVariables(
      'production',
      offline(withSpa({ production: 'https://app.acme.test' })),
      {} as SetupSecrets,
      state,
    );
    expect(variables).toMatchObject({
      REDIS_KEY_PREFIX: 'acme-be:prod:',
      WEBAUTHN_RP_ID: 'app.acme.test',
      WEBAUTHN_RP_NAME: 'Acme',
    });
  });

  it('never lets production inherit the development SPA origin', () => {
    expect(frontendUrl('production', withSpa({ development: 'http://localhost:5173' }))).toBe(
      undefined,
    );
  });
});

describe('identity-derived backend keys', () => {
  const secrets = {} as SetupSecrets;
  const config = (): SetupConfig => ({
    ...withSpa({ development: 'http://localhost:5173', production: 'https://app.acme.test' }),
    product: { name: 'acme' },
  });

  it('derives the Redis prefix, passkey RP, OAuth redirects and Scalar slug from the identity', () => {
    expect(deriveIdentityVariables('production', config(), secrets)).toEqual({
      REDIS_KEY_PREFIX: 'acme:prod:',
      WEBAUTHN_RP_NAME: 'Acme',
      WEBAUTHN_RP_ID: 'app.acme.test',
      OAUTH_GITHUB_REDIRECT_URI: 'https://app.acme.test/callback/github',
      OAUTH_GOOGLE_REDIRECT_URI: 'https://app.acme.test/callback/google',
      SCALAR_SLUG: 'acme-be-production',
    });
    expect(deriveIdentityVariables('development', config(), secrets)).toMatchObject({
      REDIS_KEY_PREFIX: 'acme:dev:',
      WEBAUTHN_RP_ID: 'localhost',
      OAUTH_GITHUB_REDIRECT_URI: 'http://localhost:5173/callback/github',
      SCALAR_SLUG: 'acme-be-development',
    });
  });

  it('tags any other environment with its own name', () => {
    expect(deriveIdentityVariables('staging', config(), secrets).REDIS_KEY_PREFIX).toBe(
      'acme:staging:',
    );
  });

  it('omits what it cannot derive instead of guessing', () => {
    const noProductionSpa: SetupConfig = {
      ...config(),
      frontend: { name: 'acme-fe', url: { development: 'http://localhost:5173' } },
    };
    const derived = deriveIdentityVariables('production', noProductionSpa, secrets);
    expect(derived).not.toHaveProperty('WEBAUTHN_RP_ID');
    expect(derived).not.toHaveProperty('OAUTH_GITHUB_REDIRECT_URI');
  });

  it('writes redirect URIs and the Scalar slug only for enabled providers', () => {
    const base = offline(config());
    const githubOnly: SetupConfig = {
      ...base,
      providers: {
        ...base.providers,
        oauth: { google: { enabled: false }, github: { enabled: true } },
      },
    };
    const derived = deriveIdentityVariables('production', githubOnly, secrets);
    expect(derived.OAUTH_GITHUB_REDIRECT_URI).toBe('https://app.acme.test/callback/github');
    expect(derived).not.toHaveProperty('OAUTH_GOOGLE_REDIRECT_URI');
    expect(derived).not.toHaveProperty('SCALAR_SLUG');
  });

  it('honours a SCALAR_SLUG override from .setup-credentials', () => {
    const override = { scalar: { slug: 'acme-api' } } as unknown as SetupSecrets;
    expect(deriveIdentityVariables('production', config(), override).SCALAR_SLUG).toBe(
      'acme-api-production',
    );
  });

  it('never writes OTEL_SERVICE_NAME — the backend names the API and the worker itself', () => {
    expect(deriveIdentityVariables('production', config(), secrets)).not.toHaveProperty(
      'OTEL_SERVICE_NAME',
    );
  });
});

describe('init wizard defaults', () => {
  it('keeps the API origin and the CORS (SPA) origins apart', () => {
    const { app } = base();
    expect(app.frontendUrl).toEqual({
      development: 'http://localhost:3000',
      production: 'https://api.example.com',
    });
    expect(app.allowedOrigins).toEqual({
      development: 'http://localhost:3000,http://localhost:5173',
      production: 'https://app.example.com',
    });
  });
});

describe('custom-domain follow-up hints', () => {
  const hints = (oauth: boolean): string =>
    downstreamEnvHints({
      environmentName: 'production',
      serviceName: 'api',
      domain: 'api.acme.test',
      oauthGoogleEnabled: false,
      oauthGithubEnabled: oauth,
    }).join('\n');

  it('points API clients at the new domain', () => {
    expect(hints(false)).toContain('app.frontendUrl.production — set to https://api.acme.test');
    expect(hints(false)).toContain(
      'gh secret set VITE_API_BASE_URL --env production --body "https://api.acme.test"',
    );
  });

  it('never tells you to point FRONTEND_URL or ALLOWED_ORIGINS at the API domain', () => {
    expect(hints(true)).not.toMatch(/gh secret set (FRONTEND_URL|ALLOWED_ORIGINS)/);
    expect(hints(true)).toContain('FRONTEND_URL, ALLOWED_ORIGINS — no change');
  });

  it('mentions OAuth redirects only when an OAuth provider is on', () => {
    expect(hints(true)).toContain('OAUTH_*_REDIRECT_URI — no change');
    expect(hints(false)).not.toContain('OAUTH_*_REDIRECT_URI');
  });
});
