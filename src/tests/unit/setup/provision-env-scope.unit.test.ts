/**
 * `--env` limits a `pnpm setup:infra` run. These tests drive the real orchestrator, provider steps
 * and env export against throwaway repos and a fake provider API — only identity review, prompts,
 * credentials and CLIs are stubbed — so a scoped run is shown not to reach another environment's
 * remote resources or env files, and an unscoped run to keep reaching all of them.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  environmentBranchMapping,
  provisionedDetailTable,
  settingsReview,
} from '@setup/common/logger.js';
import { omitUndefined } from '@setup/common/object.js';
import { setFrontendRoot, setTargetRoot } from '@setup/common/paths.js';
import { setAssumeYes } from '@setup/common/prompts.js';
import { SetupError } from '@setup/common/setup-error.js';
import { clearState, loadState } from '@setup/common/state.js';
import type { InfraProvider, SetupConfig, SetupSecrets } from '@setup/common/types.js';
import { createGithubAppViaManifest } from '@setup/github/create-github-app.js';
import { syncEnvironmentToGitHub } from '@setup/github/sync-github-environments.js';
import { oauthCallbackUrl, productResourceName } from '@setup/envs/env-file-setup.util.js';
import { exportEnvFiles } from '@setup/envs/export-env-files.js';
import { runGuide } from '@setup/infra/guide.js';
import { buildConfig } from '@setup/infra/init-wizard.js';
import {
  buildProviderContext,
  resolveEnvironmentScope,
  runProvision,
} from '@setup/infra/orchestrator.js';
import { checkPrerequisites } from '@setup/infra/prerequisites.js';
import { setupCloudflareTurnstileProvider } from '@setup/infra/providers/setup-cloudflare-turnstile/setup-cloudflare-turnstile.provider.js';
import { getInfraProviders } from '@setup/infra/providers/index.js';

const harness = vi.hoisted(() => {
  const seen = {
    preflight: [] as string[][],
    existing: [] as string[][],
    steps: [] as Array<{ environments: string[]; runEnvironments: string[] }>,
  };
  /** Stands in for the `github` provider: records what each phase is given, and enables the sync. */
  const probe: InfraProvider = {
    key: 'github',
    name: 'GitHub probe',
    isEnabled: () => true,
    disabledReason: () => '',
    detectRemote: async ({ environments }) => {
      seen.preflight.push(environments);
      return {};
    },
    detectExisting: async ({ environments }) => {
      seen.existing.push(environments);
      return [];
    },
    buildStep: ({ environments, runEnvironments }) => ({
      name: 'GitHub probe',
      enabled: true,
      instructions: [],
      execute: async () => {
        seen.steps.push({ environments, runEnvironments });
        return { success: true, message: 'probed' };
      },
    }),
  };
  return {
    seen,
    probe,
    config: {} as SetupConfig,
    secrets: {} as SetupSecrets,
    credentials: {} as Record<string, string>,
  };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: vi.fn(() => ''),
}));
vi.mock('@setup/common/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@setup/common/config.js')>()),
  loadConfig: () => harness.config,
}));
vi.mock('@setup/common/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@setup/common/logger.js')>()),
  environmentBranchMapping: vi.fn(),
  provisionedDetailTable: vi.fn(),
  settingsReview: vi.fn(),
}));
// Never the operator's real credentials file: not read, and above all not written.
vi.mock('@setup/common/secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@setup/common/secrets.js')>()),
  loadSecrets: () => harness.secrets,
  getEnvSetupValue: (key: string) => harness.credentials[key] ?? '',
  hasAnyEnvSecret: () => true,
  ensureEnvSetupTemplate: () => false,
  removeRetiredEnvSetupVariables: () => [],
}));
vi.mock('@setup/github/create-github-app.js', () => ({
  createGithubAppViaManifest: vi.fn(async () => ({
    clientId: 'app-client-id',
    clientSecret: 'app-client-secret',
    slug: 'acme-sign-in',
  })),
}));
vi.mock('@setup/github/sync-github-environments.js', () => ({
  syncEnvironmentToGitHub: vi.fn(async () => ({ pushed: 0, skipped: 0, deleted: 0 })),
}));
vi.mock('@setup/infra/guide.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@setup/infra/guide.js')>()),
  runGuide: vi.fn(async () => {}),
}));
vi.mock('@setup/infra/identity-review.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@setup/infra/identity-review.js')>()),
  reviewProjectIdentity: async () => harness.config,
}));
vi.mock('@setup/infra/next-steps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@setup/infra/next-steps.js')>()),
  runNextSteps: vi.fn(async () => {}),
}));
vi.mock('@setup/infra/prerequisites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@setup/infra/prerequisites.js')>()),
  checkPrerequisites: vi.fn(async () => true),
}));
vi.mock('@setup/infra/providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@setup/infra/providers/index.js')>();
  return {
    ...actual,
    getInfraProviders: () => [
      ...actual.getInfraProviders().filter((provider) => provider.key !== 'github'),
      harness.probe,
    ],
  };
});

const ALL_ENVIRONMENTS = ['development', 'production'];
const SENTINEL = '# not written by this run\nKEEP_ME=1\n';

type App = 'backend' | 'frontend';

let backendDir = '';
let frontendDir = '';

const appDir = (app: App): string => (app === 'backend' ? backendDir : frontendDir);
const envFile = (app: App, environment: string): string =>
  readFileSync(join(appDir(app), `.env.${environment}`), 'utf-8');

function seedEnvFile(app: App, environment: string, content = SENTINEL): void {
  writeFileSync(join(appDir(app), `.env.${environment}`), content);
}

function seedUntouched(environment: string): void {
  seedEnvFile('backend', environment);
  seedEnvFile('frontend', environment);
}

function expectUntouched(environment: string): void {
  expect(envFile('backend', environment)).toBe(SENTINEL);
  expect(envFile('frontend', environment)).toBe(SENTINEL);
}

const widgetName = (environment: string): string =>
  productResourceName(harness.config, environment);

interface ApiCall {
  method: string;
  url: string;
  body: string;
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const cloudflare = (result: unknown): Response => json({ success: true, result });

/** A fake of every provider API these tests reach. Anything else is a test failure. */
function stubProviderApis(
  remote: {
    widgets?: Array<{ name: string; sitekey: string; domains: string[]; mode: string }>;
    posthogProjects?: Array<{ id: number; name: string; api_token: string }>;
  } = {},
): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit): Promise<Response> => {
    const call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: String(init?.body ?? ''),
    };
    calls.push(call);
    if (call.url.includes('/challenges/widgets')) {
      if (call.url.endsWith('/rotate_secret')) return cloudflare({ secret: 'rotated-secret' });
      if (call.method === 'GET') return cloudflare(remote.widgets ?? []);
      if (call.method === 'PUT') return cloudflare({});
      const { name } = JSON.parse(call.body) as { name: string };
      return cloudflare({ name, sitekey: `site-${name}`, secret: `secret-${name}` });
    }
    if (call.url.endsWith('/workspaces')) {
      return json({ workspaces: [{ id: 'workspace-1', name: harness.config.project.name }] });
    }
    if (call.url.endsWith('/api/projects/')) return json({ results: remote.posthogProjects ?? [] });
    // GitHub authenticated the app; only the probe token is bad — the credentials are valid.
    if (call.url.includes('api.github.com/applications/')) {
      return new Response('', { status: 404 });
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  return calls;
}

const describeCalls = (calls: ApiCall[]): string =>
  calls.map((call) => `${call.method} ${call.url} ${call.body}`).join('\n');

async function provision(providers: string[], environments?: string[]): Promise<void> {
  await runProvision(
    omitUndefined({ providerSelection: { includeKeys: providers }, environments }),
  );
  // `--yes` skips a failed step and carries on, so a swallowed failure must still fail the test.
  expect(process.exitCode).toBeUndefined();
}

beforeEach(() => {
  backendDir = mkdtempSync(join(tmpdir(), 'env-scope-be-'));
  frontendDir = mkdtempSync(join(tmpdir(), 'env-scope-fe-'));
  // The env vars outrank every other root, so nothing here can reach the real sibling repos.
  vi.stubEnv('CLINOZY_BE_DIR', backendDir);
  vi.stubEnv('CLINOZY_FE_DIR', frontendDir);
  setTargetRoot(undefined);
  setFrontendRoot(undefined);

  const base = buildConfig('acme-org', 'acme-be', 'Acme Backend', ALL_ENVIRONMENTS);
  harness.config = {
    ...base,
    frontend: {
      name: 'acme-fe',
      url: { development: 'https://dev.acme.test', production: 'https://app.acme.test' },
    },
    providers: {
      ...base.providers,
      github: { ...base.providers.github, enabled: true, syncEnvironments: true },
      oauth: { ...base.providers.oauth, github: { enabled: true } },
    },
  };
  harness.secrets = {
    neon: { apiKey: '' },
    aws: { accessKeyId: '', secretAccessKey: '' },
    sentry: { authToken: '' },
    resend: { apiKey: '' },
    railway: {},
    cloudflare: { apiToken: 'cloudflare-token', accountId: 'cloudflare-account' },
    postman: { apiKey: 'postman-key' },
    github: {},
    netlify: {},
    scalar: { apiKey: 'scalar-key' },
  };
  harness.credentials = { POSTHOG_PERSONAL_API_KEY: 'phx_test' };
  harness.seen.preflight = [];
  harness.seen.existing = [];
  harness.seen.steps = [];

  clearState();
  vi.clearAllMocks();
  setAssumeYes(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setAssumeYes(false);
  setTargetRoot(undefined);
  setFrontendRoot(undefined);
  process.exitCode = undefined;
  rmSync(backendDir, { recursive: true, force: true });
  rmSync(frontendDir, { recursive: true, force: true });
});

describe('resolveEnvironmentScope', () => {
  it('keeps every configured environment when --env is absent', () => {
    expect(resolveEnvironmentScope(ALL_ENVIRONMENTS)).toEqual(ALL_ENVIRONMENTS);
  });

  it('returns the requested environments in config order, without duplicates', () => {
    const configured = ['development', 'staging', 'production'];
    expect(
      resolveEnvironmentScope(configured, ['production', 'development', 'production']),
    ).toEqual(['development', 'production']);
  });

  it('fails on a name that is not configured, naming it and the configured ones', () => {
    const attempt = (): string[] =>
      resolveEnvironmentScope(ALL_ENVIRONMENTS, ['development', 'staging']);
    expect(attempt).toThrow(SetupError);
    expect(attempt).toThrow(/staging/);
    expect(attempt).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('production') }),
    );
  });

  it('fails on --env with no value instead of running everywhere', () => {
    expect(() => resolveEnvironmentScope(ALL_ENVIRONMENTS, [])).toThrow(SetupError);
  });
});

describe('exportEnvFiles', () => {
  it('writes only the scoped environment, in both apps', () => {
    seedUntouched('production');

    expect(exportEnvFiles(['development'])).toEqual({
      written: ['.env.development'],
      merged: [],
      frontendWritten: ['.env.development'],
      frontendMerged: [],
    });
    expectUntouched('production');
  });

  it('writes every configured environment when no scope is given', () => {
    expect(exportEnvFiles()).toEqual({
      written: ['.env.development', '.env.production'],
      merged: [],
      frontendWritten: ['.env.development', '.env.production'],
      frontendMerged: [],
    });
  });
});

describe.each([
  { inScope: 'development', other: 'production' },
  { inScope: 'production', other: 'development' },
])('runProvision --env $inScope', ({ inScope, other }) => {
  it('provisions only its own Turnstile widget and env files', async () => {
    const calls = stubProviderApis({
      // Domains out of date and no secret on file: an unscoped run would update and rotate this.
      widgets: [
        {
          name: widgetName(other),
          sitekey: 'other-sitekey',
          domains: ['stale.acme.test'],
          mode: 'managed',
        },
      ],
    });
    seedUntouched(other);

    await provision(['turnstile'], [inScope]);

    const requests = describeCalls(calls);
    expect(requests).toContain(`"name":"${widgetName(inScope)}"`);
    expect(requests).not.toContain('other-sitekey');
    expect(requests).not.toContain(widgetName(other));
    expect(envFile('backend', inScope)).toContain(`site-${widgetName(inScope)}`);
    expect(envFile('backend', inScope)).toContain(`secret-${widgetName(inScope)}`);
    expect(envFile('frontend', inScope)).toContain(`site-${widgetName(inScope)}`);
    expectUntouched(other);
  });

  it('hands the scope to the prerequisites, guide, pre-flight, steps and GitHub sync', async () => {
    await provision(['github'], [inScope]);

    const selected = new Set(['github']);
    expect(checkPrerequisites).toHaveBeenCalledWith(harness.config, selected, [inScope]);
    expect(runGuide).toHaveBeenCalledWith(harness.config, [inScope], selected);
    expect(harness.seen.preflight).toEqual([[inScope]]);
    expect(harness.seen.existing).toEqual([[inScope]]);
    expect(harness.seen.steps).toEqual([{ environments: [inScope], runEnvironments: [inScope] }]);
    expect(vi.mocked(syncEnvironmentToGitHub).mock.calls.map(([call]) => call.environment)).toEqual(
      [inScope],
    );
  });

  it('shows the operator only that environment before asking to proceed', async () => {
    await provision(['github'], [inScope]);

    const names = (entries: Array<string | { name: string }>): string[] =>
      entries.map((entry) => (typeof entry === 'string' ? entry : entry.name));
    expect(
      vi.mocked(environmentBranchMapping).mock.calls.map(([entries]) => names(entries)),
    ).toEqual([[inScope]]);
    expect(vi.mocked(settingsReview).mock.calls.map(([, , entries]) => names(entries))).toEqual([
      [inScope],
    ]);
  });

  it('keeps the Postman and Scalar steps out of the other env files', async () => {
    stubProviderApis();
    seedUntouched(other);

    await provision(['postman', 'scalar'], [inScope]);

    expect(envFile('backend', inScope)).toContain('POSTMAN_WORKSPACE_ID=workspace-1');
    expectUntouched(other);
  });

  it('creates a GitHub App for its own environment only', async () => {
    stubProviderApis();
    seedUntouched(other);

    await provision(['github-app-with-oauth'], [inScope]);

    expect(createGithubAppViaManifest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createGithubAppViaManifest).mock.calls[0]?.[0].callbackUrls).toEqual([
      oauthCallbackUrl(harness.config, inScope, 'github'),
    ]);
    expect(envFile('backend', inScope)).toContain('OAUTH_GITHUB_CLIENT_ID=app-client-id');
    expectUntouched(other);
  });

  it('keeps valid GitHub App credentials when only the other environment lacks them', async () => {
    stubProviderApis();
    seedUntouched(other);
    seedEnvFile(
      'backend',
      inScope,
      'OAUTH_GITHUB_CLIENT_ID=existing-id\nOAUTH_GITHUB_CLIENT_SECRET=existing-secret\n',
    );

    await provision(['github-app-with-oauth'], [inScope]);

    expect(createGithubAppViaManifest).not.toHaveBeenCalled();
    expect(envFile('backend', inScope)).toContain('OAUTH_GITHUB_CLIENT_ID=existing-id');
    expectUntouched(other);
  });

  it('resolves its own PostHog project without looking for the missing other one', async () => {
    const calls = stubProviderApis({
      posthogProjects: [{ id: 1, name: widgetName(inScope), api_token: 'phc_in_scope' }],
    });
    seedUntouched(other);

    await provision(['posthog'], [inScope]);

    // The other project is missing: resolving it would have gone on to find the org and create it.
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    expect(envFile('backend', inScope)).toContain('POSTHOG_KEY=phc_in_scope');
    expectUntouched(other);
  });

  it('marks the step as created in the final per-environment table', async () => {
    stubProviderApis();

    await provision(['turnstile'], [inScope]);

    const [sections] = vi.mocked(provisionedDetailTable).mock.calls[0] ?? [];
    expect(sections?.[0]).toMatchObject({
      title: inScope,
      rows: [{ provider: 'Cloudflare Turnstile', status: 'created' }],
    });
  });
});

describe('runProvision scope failures', () => {
  it.each([
    ['an unknown environment', ['staging']],
    ['an environment list with an unknown name', ['development', 'staging']],
    ['--env with no value', []],
  ])('stops on %s before anything is touched', async (_label, environments) => {
    const calls = stubProviderApis();

    await expect(runProvision({ environments })).rejects.toBeInstanceOf(SetupError);

    expect(calls).toEqual([]);
    expect(checkPrerequisites).not.toHaveBeenCalled();
    expect(readdirSync(backendDir)).toEqual([]);
    expect(readdirSync(frontendDir)).toEqual([]);
  });
});

describe('runProvision without --env', () => {
  it('provisions every environment, one at a time, in both apps', async () => {
    const calls = stubProviderApis({
      widgets: [
        {
          name: widgetName('production'),
          sitekey: 'production-sitekey',
          domains: ['stale.acme.test'],
          mode: 'managed',
        },
      ],
    });

    await provision(['github', 'turnstile']);

    expect(harness.seen.preflight).toEqual([ALL_ENVIRONMENTS]);
    expect(harness.seen.steps).toEqual(
      ALL_ENVIRONMENTS.map((environment) => ({
        environments: [environment],
        runEnvironments: ALL_ENVIRONMENTS,
      })),
    );
    expect(vi.mocked(syncEnvironmentToGitHub).mock.calls.map(([call]) => call.environment)).toEqual(
      ALL_ENVIRONMENTS,
    );
    expect(describeCalls(calls)).toContain('PUT');
    expect(describeCalls(calls)).toContain('production-sitekey/rotate_secret');
    expect(envFile('backend', 'development')).toContain(`site-${widgetName('development')}`);
    expect(envFile('frontend', 'development')).toContain(`site-${widgetName('development')}`);
    expect(envFile('backend', 'production')).toContain('production-sitekey');
    expect(envFile('frontend', 'production')).toContain('production-sitekey');
  });

  it('records the Postman workspace in every environment', async () => {
    stubProviderApis();

    await provision(['postman']);

    for (const environment of ALL_ENVIRONMENTS) {
      expect(envFile('backend', environment)).toContain('POSTMAN_WORKSPACE_ID=workspace-1');
    }
  });

  it('shares one GitHub App across every environment', async () => {
    stubProviderApis();

    await provision(['github-app-with-oauth']);

    expect(createGithubAppViaManifest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createGithubAppViaManifest).mock.calls[0]?.[0].callbackUrls).toEqual(
      ALL_ENVIRONMENTS.map((environment) =>
        oauthCallbackUrl(harness.config, environment, 'github'),
      ),
    );
    for (const environment of ALL_ENVIRONMENTS) {
      expect(envFile('backend', environment)).toContain('OAUTH_GITHUB_CLIENT_ID=app-client-id');
    }
  });

  it('resolves every environment on the first PostHog step', async () => {
    stubProviderApis({
      posthogProjects: ALL_ENVIRONMENTS.map((environment, index) => ({
        id: index,
        name: widgetName(environment),
        api_token: `phc_${environment}`,
      })),
    });

    await provision(['posthog']);

    expect(loadState().posthog?.projectApiKeys).toEqual({
      development: 'phc_development',
      production: 'phc_production',
    });
  });
});

describe('step previews under a scope', () => {
  const step = (key: string, runEnvironments: string[]) => {
    const provider = getInfraProviders().find((candidate) => candidate.key === key);
    if (!provider) throw new Error(`No provider ${key}`);
    return provider.buildStep(
      buildProviderContext(
        harness.config,
        harness.secrets,
        loadState(),
        runEnvironments,
        runEnvironments,
      ),
    );
  };

  it.each(['railway', 'google-oauth', 'posthog'])(
    '%s describes only the scoped environment',
    (key) => {
      expect(step(key, ['development']).instructions.join('\n')).toContain('development');
      expect(step(key, ['development']).instructions.join('\n')).not.toContain('production');
      expect(step(key, ALL_ENVIRONMENTS).instructions.join('\n')).toContain('production');
    },
  );

  it('reports Turnstile by the environments in the run, not every configured one', async () => {
    seedEnvFile('backend', 'development', 'CAPTCHA_SITE_KEY=site\nCAPTCHA_SECRET=secret\n');
    const status = (runEnvironments: string[]) =>
      setupCloudflareTurnstileProvider
        .buildStep(
          buildProviderContext(harness.config, harness.secrets, loadState(), runEnvironments),
        )
        .detectStatus?.();

    expect(await status(['development'])).toMatchObject({ state: 'present' });
    expect(await status(ALL_ENVIRONMENTS)).toMatchObject({ state: 'absent' });
  });
});
