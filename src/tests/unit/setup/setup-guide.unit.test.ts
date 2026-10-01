import { describe, expect, it } from 'vitest';
import type { SetupConfig } from '@setup/common/types.js';
import {
  buildGuideData,
  serviceStatusFor,
  withStatus,
  type GuideService,
} from '@setup/infra/setup-guide/data.js';
import { renderGuideHtml } from '@setup/infra/setup-guide/render.js';
import { PRESETS } from '@setup/presets/index.js';

const config = {
  project: { name: 'clinozy-be', displayName: 'clinozy-be', organization: 'albetrios' },
  environments: [
    { name: 'development', nodeEnvironment: 'development', deployBranch: 'dev', isDefault: true },
    { name: 'production', nodeEnvironment: 'production', deployBranch: 'main' },
  ],
} as unknown as SetupConfig;

function serviceByName(name: string) {
  return buildGuideData(config, PRESETS).services.find((s) => s.name === name);
}

describe('buildGuideData', () => {
  it('emits one service per preset with the project + environments from config', () => {
    const data = buildGuideData(config, PRESETS);
    expect(data.services).toHaveLength(PRESETS.length);
    expect(data.project).toBe('clinozy-be');
    expect(data.environments).toEqual(['development', 'production']);
    expect(data.credsFile).toBe('.setup/.setup-credentials');
  });

  it('groups an account-key service (Neon) with its credential + dashboard', () => {
    const neon = serviceByName('Neon Postgres');
    expect(neon?.group).toBe('account');
    expect(neon?.credentials).toContain('NEON_API_KEY');
    expect(neon?.dashboard?.url).toMatch(/neon\.tech/);
    expect(neon?.outputs).toContain('DATABASE_URL');
  });

  it('groups a paste-per-env service (Stripe) under paste', () => {
    expect(serviceByName('Stripe')?.group).toBe('paste');
  });

  it('scopes to a subset of environments when -e is given', () => {
    const data = buildGuideData(config, PRESETS, { environments: ['production'] });
    expect(data.environments).toEqual(['production']);
  });

  it('falls back to all environments when the scope matches none', () => {
    const data = buildGuideData(config, PRESETS, { environments: ['nope'] });
    expect(data.environments).toEqual(['development', 'production']);
  });

  it('groups a local-only service (JWT) under auto with no credentials', () => {
    const jwt = serviceByName('JWT secrets');
    expect(jwt?.group).toBe('auto');
    expect(jwt?.credentials).toEqual([]);
  });

  it('gives every service a non-empty step-by-step walkthrough', () => {
    for (const s of buildGuideData(config, PRESETS).services) {
      expect(s.steps.length).toBeGreaterThan(0);
    }
  });

  it('uses an explicit preset override for nuanced steps (Stripe webhook)', () => {
    const stripe = serviceByName('Stripe');
    expect(stripe?.steps.join(' ')).toMatch(/webhook/i);
  });

  it('derives account steps that name the credential + file (Neon)', () => {
    const neon = serviceByName('Neon Postgres');
    expect(neon?.steps.join(' ')).toContain('NEON_API_KEY');
    expect(neon?.steps.join(' ')).toContain('.setup/.setup-credentials');
  });

  it('derives clinozy-fe VITE_ mirror keys (Sentry, PostHog)', () => {
    expect(serviceByName('Sentry')?.feKeys).toEqual(
      expect.arrayContaining(['VITE_SENTRY_DSN', 'SENTRY_ORG', 'SENTRY_PROJECT']),
    );
    expect(serviceByName('PostHog')?.feKeys).toContain('VITE_POSTHOG_KEY');
  });
});

describe('serviceStatusFor (live status, presence only)', () => {
  const svc = (over: Partial<GuideService>): GuideService => ({
    name: 'X',
    kind: 'managed',
    group: 'account',
    credentials: [],
    outputs: [],
    feKeys: [],
    steps: [],
    ...over,
  });

  it('is complete when all outputs are present in .env.<env>', () => {
    const s = svc({ outputs: ['A', 'B'] });
    const status = serviceStatusFor(s, 'development', {
      readEnvValue: () => 'v',
      hasCredential: () => false,
    });
    expect(status).toBe('complete');
  });

  it('is partial when only some outputs are present', () => {
    const s = svc({ outputs: ['A', 'B'] });
    const status = serviceStatusFor(s, 'development', {
      readEnvValue: (_e, k) => (k === 'A' ? 'v' : undefined),
      hasCredential: () => false,
    });
    expect(status).toBe('partial');
  });

  it('is missing when no outputs are present', () => {
    const s = svc({ outputs: ['A'] });
    expect(
      serviceStatusFor(s, 'development', {
        readEnvValue: () => undefined,
        hasCredential: () => false,
      }),
    ).toBe('missing');
  });

  it('falls back to credential presence for output-less services', () => {
    const s = svc({ outputs: [], credentials: ['TOK'] });
    expect(
      serviceStatusFor(s, 'development', {
        readEnvValue: () => undefined,
        hasCredential: () => true,
      }),
    ).toBe('complete');
    expect(
      serviceStatusFor(s, 'development', {
        readEnvValue: () => undefined,
        hasCredential: () => false,
      }),
    ).toBe('missing');
  });
});

describe('withStatus', () => {
  it('attaches per-environment status to every service', () => {
    const data = buildGuideData(config, PRESETS);
    const withS = withStatus(data, { readEnvValue: () => undefined, hasCredential: () => false });
    for (const s of withS.services) {
      expect(Object.keys(s.status ?? {})).toEqual(data.environments);
      // nothing present → every service missing
      expect(Object.values(s.status ?? {})).toEqual(data.environments.map(() => 'missing'));
    }
  });
});

describe('renderGuideHtml', () => {
  it('injects the data into the template and leaves no marker behind', () => {
    const data = buildGuideData(config, PRESETS);
    const template = 'before window.__GUIDE__ = /*__GUIDE_DATA__*/ null; after';
    const html = renderGuideHtml(data, template);
    expect(html).not.toContain('/*__GUIDE_DATA__*/ null');
    expect(html).toContain('"project":"clinozy-be"');
    expect(html).toContain('"NEON_API_KEY"');
  });

  it('throws when the template lacks the data marker', () => {
    expect(() => renderGuideHtml(buildGuideData(config, PRESETS), 'no marker here')).toThrow(
      /data marker/,
    );
  });
});
