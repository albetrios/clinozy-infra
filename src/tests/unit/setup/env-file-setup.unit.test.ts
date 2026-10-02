import { describe, expect, it } from 'vitest';
import type { SetupConfig, SetupState } from '@setup/common/types.js';
import {
  deployedApiOrigin,
  defaultCollectionDecision,
  oauthCallbackUrl,
  parseEnvironmentCollectionDecision,
  resolveNonInteractiveFieldValue,
} from '@setup/envs/env-file-setup.util.js';
import { usesEnvironmentFirstTraversal } from '@setup/common/interactive-step.js';

function configWithOrigins(frontendUrl: Record<string, string>): SetupConfig {
  return {
    environments: [
      { name: 'development', nodeEnvironment: 'development' },
      { name: 'production', nodeEnvironment: 'production' },
    ],
    providers: {},
    frontend: { name: 'clinozy-fe', url: frontendUrl },
    // The API origin must never leak into the redirect URI.
    app: { frontendUrl: { development: 'http://localhost:3000', production: 'https://api.x.io' } },
  } as unknown as SetupConfig;
}

describe('oauthCallbackUrl (SPA /callback/<provider> page — clinozy-be redirect URI contract)', () => {
  it('builds the redirect URI from the frontend origin, not the backend origin', () => {
    const config = configWithOrigins({ development: 'http://localhost:5173', production: '' });
    expect(oauthCallbackUrl(config, 'development', 'google')).toBe(
      'http://localhost:5173/callback/google',
    );
    expect(oauthCallbackUrl(config, 'development', 'github')).toBe(
      'http://localhost:5173/callback/github',
    );
  });

  it('falls back to the Vite dev origin for development', () => {
    expect(oauthCallbackUrl(configWithOrigins({}), 'development', 'google')).toBe(
      'http://localhost:5173/callback/google',
    );
  });

  it('returns empty when the frontend origin is unknown outside development', () => {
    const config = configWithOrigins({ development: 'http://localhost:5173', production: '' });
    expect(oauthCallbackUrl(config, 'production', 'google')).toBe('');
  });

  it('tolerates a trailing slash on the configured origin (redirect URIs match exactly)', () => {
    const config = configWithOrigins({ production: 'https://app.x.io/' });
    expect(oauthCallbackUrl(config, 'production', 'github')).toBe(
      'https://app.x.io/callback/github',
    );
  });
});

describe('parseEnvironmentCollectionDecision', () => {
  it('accepts continue aliases', () => {
    expect(parseEnvironmentCollectionDecision('c')).toBe('continue');
    expect(parseEnvironmentCollectionDecision('continue')).toBe('continue');
    expect(parseEnvironmentCollectionDecision('Y')).toBe('continue');
  });

  it('accepts skip aliases', () => {
    expect(parseEnvironmentCollectionDecision('s')).toBe('skip');
    expect(parseEnvironmentCollectionDecision('skip')).toBe('skip');
  });

  it('accepts abort aliases', () => {
    expect(parseEnvironmentCollectionDecision('a')).toBe('abort');
    expect(parseEnvironmentCollectionDecision('abort')).toBe('abort');
    expect(parseEnvironmentCollectionDecision('quit')).toBe('abort');
  });

  it('rejects unknown input', () => {
    expect(parseEnvironmentCollectionDecision('')).toBeNull();
    expect(parseEnvironmentCollectionDecision('maybe')).toBeNull();
  });
});

describe('usesEnvironmentFirstTraversal', () => {
  it('is false for a single environment', () => {
    expect(usesEnvironmentFirstTraversal(['development'])).toBe(false);
  });

  it('is true when more than one environment is configured', () => {
    expect(usesEnvironmentFirstTraversal(['development', 'production'])).toBe(true);
  });
});

describe('defaultCollectionDecision (keep-existing unless --force)', () => {
  it('keeps an already-configured env by default (skip)', () => {
    expect(defaultCollectionDecision(true, false)).toBe('s');
  });

  it('configures a not-yet-set env by default (continue)', () => {
    expect(defaultCollectionDecision(false, false)).toBe('c');
  });

  it('re-collects even an already-configured env under --force', () => {
    expect(defaultCollectionDecision(true, true)).toBe('c');
    expect(defaultCollectionDecision(false, true)).toBe('c');
  });
});

describe('resolveNonInteractiveFieldValue', () => {
  it('prefers a per-environment override (KEY__env) over the shared key', () => {
    const env = { STRIPE_SECRET_KEY__production: 'sk_live', STRIPE_SECRET_KEY: 'sk_shared' };
    expect(resolveNonInteractiveFieldValue('STRIPE_SECRET_KEY', 'production', env)).toBe('sk_live');
  });

  it('falls back to the shared key when no per-environment override is set', () => {
    const env = { STRIPE_SECRET_KEY: 'sk_shared' };
    expect(resolveNonInteractiveFieldValue('STRIPE_SECRET_KEY', 'development', env)).toBe(
      'sk_shared',
    );
  });

  it('never uses the shared key for a per-environment field', () => {
    const env = { STRIPE_SECRET_KEY: 'sk_test_from_shell' };
    expect(
      resolveNonInteractiveFieldValue('STRIPE_SECRET_KEY', 'production', env, { shared: false }),
    ).toBeUndefined();
  });

  it('trims whitespace and treats blank as unset', () => {
    expect(resolveNonInteractiveFieldValue('K', 'development', { K: '  v  ' })).toBe('v');
    expect(resolveNonInteractiveFieldValue('K', 'development', { K: '   ' })).toBeUndefined();
  });

  it('returns undefined when neither key is present (keeps the on-disk value)', () => {
    expect(resolveNonInteractiveFieldValue('K', 'development', {})).toBeUndefined();
  });
});

describe('deployedApiOrigin (what the hosted frontend calls)', () => {
  const stateWith = (api: Record<string, unknown>): SetupState =>
    ({
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      railway: {
        projectId: 'p',
        services: {},
        environments: {
          production: { environmentId: 'e', services: { api: { serviceId: 's', ...api } } },
        },
      },
    }) as unknown as SetupState;

  it('prefers a custom domain over the Railway-generated one', () => {
    const state = stateWith({
      url: 'https://api-production-1234.up.railway.app',
      customDomain: { domain: 'api.acme.test' },
    });
    expect(deployedApiOrigin(state, 'production')).toBe('https://api.acme.test');
  });

  it('falls back to the generated domain, adding the scheme when it is missing', () => {
    expect(
      deployedApiOrigin(stateWith({ url: 'https://api-x.up.railway.app' }), 'production'),
    ).toBe('https://api-x.up.railway.app');
    expect(deployedApiOrigin(stateWith({ url: 'api-x.up.railway.app' }), 'production')).toBe(
      'https://api-x.up.railway.app',
    );
  });

  it('is empty when nothing is deployed for that environment', () => {
    expect(deployedApiOrigin(stateWith({}), 'production')).toBe('');
    expect(
      deployedApiOrigin(stateWith({ url: 'https://api-x.up.railway.app' }), 'development'),
    ).toBe('');
  });
});
