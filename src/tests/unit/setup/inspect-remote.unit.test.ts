import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSentryProvider } from '@setup/infra/providers/setup-sentry/setup-sentry.provider.js';
import { setupPosthogProvider } from '@setup/infra/providers/setup-posthog/setup-posthog.provider.js';
import type { InfraProviderContext } from '@setup/common/types.js';

// Minimal context — inspectRemote only reads config.providers.* + secrets.* + environments.
function context(overrides: Partial<InfraProviderContext> = {}): InfraProviderContext {
  return {
    config: {
      project: { name: 'clinozy-be', displayName: 'clinozy-be', organization: 'albetrios' },
      environments: [
        { name: 'development', deployBranch: 'dev' },
        { name: 'production', deployBranch: 'main' },
      ],
      providers: {
        sentry: {
          enabled: true,
          organization: 'albetrios',
          project: 'clinozy-be',
          platform: 'node',
        },
        posthog: { enabled: true, region: 'us' },
      },
    },
    secrets: { sentry: { authToken: 'tok' }, posthog: { personalApiKey: 'phx_x' } },
    state: {},
    environments: ['development', 'production'],
    applyStateUpdates: () => {},
    ...overrides,
  } as unknown as InfraProviderContext;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Sentry inspectRemote', () => {
  it('present + in sync when remote matches config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ slug: 'clinozy-be', platform: 'node' })),
    );
    const result = await setupSentryProvider.inspectRemote?.(context());
    expect(result?.present).toBe(true);
    expect(result?.fields.find((f) => f.label === 'project')?.matches).toBe(true);
    expect(result?.fields.find((f) => f.label === 'platform')?.matches).toBe(true);
  });

  it('flags drift when remote platform differs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ slug: 'clinozy-be', platform: 'python' })),
    );
    const result = await setupSentryProvider.inspectRemote?.(context());
    expect(result?.present).toBe(true);
    expect(result?.fields.find((f) => f.label === 'platform')?.matches).toBe(false);
  });

  it('absent when the project 404s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    const result = await setupSentryProvider.inspectRemote?.(context());
    expect(result?.present).toBe(false);
  });

  it('reports error (no throw) when token missing', async () => {
    const result = await setupSentryProvider.inspectRemote?.(
      context({ secrets: { sentry: { authToken: '' } } } as unknown as InfraProviderContext),
    );
    expect(result?.present).toBe(false);
    expect(result?.error).toMatch(/SENTRY_AUTH_TOKEN/);
  });
});

describe('PostHog inspectRemote', () => {
  // inspectRemote reads POSTHOG_PERSONAL_API_KEY from the setup-credentials source (process.env
  // overlay). Stub it so the test is hermetic instead of depending on a real .setup-credentials.
  beforeEach(() => vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_x'));

  it('present per env when the <product>-<env> projects exist (shared FE+BE)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          results: [{ name: 'clinozy-be-development' }, { name: 'clinozy-be-production' }],
        }),
      ),
    );
    const result = await setupPosthogProvider.inspectRemote?.(context());
    expect(result?.present).toBe(true);
    expect(result?.fields.find((f) => f.label === 'project (development)')?.matches).toBe(true);
    expect(result?.fields.find((f) => f.label === 'project (production)')?.matches).toBe(true);
  });

  it('absent when a per-env project is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [{ name: 'clinozy-be-development' }] })),
    );
    const result = await setupPosthogProvider.inspectRemote?.(context());
    expect(result?.present).toBe(false);
    expect(result?.fields.find((f) => f.label === 'project (production)')?.matches).toBe(false);
  });
});
