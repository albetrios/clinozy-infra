/**
 * The next-steps checklist and the backend database-user helpers. Live checks are injected, so
 * nothing here touches DNS, GitHub or a database. Invented names (`acme`).
 */
import { describe, expect, it } from 'vitest';
import {
  type DnsRequirement,
  plainDnsType,
  requireDnsRecord,
  collectedDnsRequirements,
} from '@setup/common/dns-requirements.js';
import type { SetupConfig } from '@setup/common/types.js';
import { buildConfig } from '@setup/infra/init-wizard.js';
import {
  type NextStepChecks,
  buildNextSteps,
  isStripeWebhookSigningSecret,
  mergeDnsRequirements,
} from '@setup/infra/next-steps.js';
import {
  backendRoleName,
  passwordFromEnvUrl,
} from '@setup/infra/providers/setup-neon/setup-neon.provider.js';

const config = (): SetupConfig => {
  const base = buildConfig('acme-org', 'acme-be', 'Acme Backend', ['development', 'production']);
  return {
    ...base,
    product: { name: 'acme', domain: 'acme.test' },
    frontend: { name: 'acme-fe' },
    providers: {
      ...base.providers,
      github: { ...base.providers.github, repository: 'acme-org/acme-be' },
    },
  };
};

const records: DnsRequirement[] = [
  { provider: 'Netlify', type: 'CNAME', name: 'app.acme.test', value: 'acme-fe.netlify.app' },
  { provider: 'Railway', type: 'CNAME', name: 'api.acme.test', value: 'x.up.railway.app' },
];

const checks = (overrides: Partial<NextStepChecks> = {}): NextStepChecks => ({
  dnsRecordLive: async () => true,
  githubEnvironmentHasSecrets: async () => true,
  repositoryIsPrivate: async () => false,
  envValue: (environment, key) =>
    ({
      DATABASE_URL: `postgresql://acme_be_app:pw@h/db`,
      DATABASE_MAINTENANCE_URL: `postgresql://acme_be_maintenance:pw@h/db`,
      DATABASE_MIGRATION_URL: `postgresql://acme_be_migrator:pw@h/db`,
    })[key] ?? (environment ? undefined : undefined),
  ...overrides,
});

describe('buildNextSteps', () => {
  it('orders the steps: DNS first, go-live last', async () => {
    const steps = await buildNextSteps({ config: config(), dnsRecords: records, checks: checks() });
    expect(steps[0]?.title).toMatch(/Register acme\.test/);
    expect(steps.at(-1)?.title).toMatch(/Go live/);
  });

  it('marks DNS done only when every record resolves to its value', async () => {
    const live = await buildNextSteps({ config: config(), dnsRecords: records, checks: checks() });
    expect(live[0]).toMatchObject({ status: 'done' });
    const missing = await buildNextSteps({
      config: config(),
      dnsRecords: records,
      checks: checks({ dnsRecordLive: async (record) => record.name !== 'api.acme.test' }),
    });
    expect(missing[0]?.status).toBe('todo');
    expect(missing[0]?.lines).toContainEqual(expect.stringMatching(/^✗ CNAME api\.acme\.test/));
  });

  it('checks every app × environment for synced GitHub secrets', async () => {
    const seen: string[] = [];
    const steps = await buildNextSteps({
      config: config(),
      dnsRecords: records,
      checks: checks({
        githubEnvironmentHasSecrets: async (repository, environment) => {
          seen.push(`${repository}:${environment}`);
          return repository !== 'acme-org/acme-fe';
        },
      }),
    });
    expect(seen.sort()).toEqual([
      'acme-org/acme-be:development',
      'acme-org/acme-be:production',
      'acme-org/acme-fe:development',
      'acme-org/acme-fe:production',
    ]);
    expect(steps.find((step) => step.title.startsWith('Push the env files'))?.status).toBe('todo');
  });

  it('marks the database users done only when each URL names its backend role', async () => {
    const done = await buildNextSteps({ config: config(), dnsRecords: records, checks: checks() });
    expect(done.find((step) => step.title.startsWith('Backend database users'))?.status).toBe(
      'done',
    );
    const oldRuntimeLogin = await buildNextSteps({
      config: config(),
      dnsRecords: records,
      checks: checks({
        envValue: (environment, key) =>
          key === 'DATABASE_URL'
            ? `postgresql://${environment}_app_login:pw@h/db`
            : checks().envValue(environment, key),
      }),
    });
    expect(
      oldRuntimeLogin.find((step) => step.title.startsWith('Backend database users'))?.status,
    ).toBe('todo');
    const providerOwnerMigrations = await buildNextSteps({
      config: config(),
      dnsRecords: records,
      checks: checks({
        envValue: (environment, key) =>
          key === 'DATABASE_MIGRATION_URL'
            ? 'postgresql://neondb_owner:pw@h/db'
            : checks().envValue(environment, key),
      }),
    });
    expect(
      providerOwnerMigrations.find((step) => step.title.startsWith('Backend database users'))
        ?.status,
    ).toBe('todo');
  });

  it('lists Stripe keys per environment and flags a test-mode key in production', async () => {
    const base = config();
    const stripeConfig: SetupConfig = {
      ...base,
      app: { ...base.app, frontendUrl: {} }, // derive the API hosts from product.domain
      providers: { ...base.providers, stripe: { ...base.providers.stripe, enabled: true } },
    };
    const values = (secretKey: (environment: string) => string, webhookSecret: string) =>
      checks({
        envValue: (environment, key) =>
          ({
            STRIPE_SECRET_KEY: secretKey(environment),
            STRIPE_WEBHOOK_SECRET: webhookSecret,
            STRIPE_PUBLISHABLE_KEY: 'pk_x',
          })[key],
      });
    const stripeStep = async (
      secretKey: (environment: string) => string,
      webhookSecret = 'whsec_x',
    ) =>
      (
        await buildNextSteps({
          config: stripeConfig,
          dnsRecords: records,
          checks: values(secretKey, webhookSecret),
        })
      ).find((step) => step.title.startsWith('Stripe'));

    const live = await stripeStep((environment) =>
      environment === 'production' ? 'sk_live_x' : 'sk_test_x',
    );
    expect(live?.status).toBe('manual');
    expect(live?.lines).toContainEqual(
      expect.stringContaining(
        'development: https://development--api.acme.test/api/v1/billing/webhook',
      ),
    );
    const testInProduction = await stripeStep(() => 'sk_test_x');
    expect(testInProduction?.status).toBe('todo');
    expect(testInProduction?.lines).toContainEqual(
      expect.stringMatching(/^✗ production: .*sk_live_/),
    );

    // A destination id or an API key in place of the signing secret stops the backend's deploy.
    const liveKeys = (environment: string) =>
      environment === 'production' ? 'sk_live_x' : 'sk_test_x';
    const wrongWebhookSecret = await stripeStep(liveKeys, 'we_1Destination');
    expect(wrongWebhookSecret?.status).toBe('todo');
    expect(wrongWebhookSecret?.lines).toContainEqual(
      expect.stringMatching(/✗ STRIPE_WEBHOOK_SECRET \(not a signing secret — needs .*whsec_/),
    );
    // A rotation list of signing secrets is fine.
    expect((await stripeStep(liveKeys, 'whsec_old, whsec_new'))?.status).toBe('manual');
  });

  it('accepts only Stripe signing secrets, alone or as a rotation list', () => {
    expect(isStripeWebhookSigningSecret('whsec_abc')).toBe(true);
    expect(isStripeWebhookSigningSecret('whsec_old,whsec_new')).toBe(true);
    expect(isStripeWebhookSigningSecret('we_1Destination')).toBe(false);
    expect(isStripeWebhookSigningSecret('sk_test_x')).toBe(false);
    expect(isStripeWebhookSigningSecret('whsec_ok,we_1Bad')).toBe(false);
    expect(isStripeWebhookSigningSecret(' , ')).toBe(false);
  });

  it('lists the Google redirect URIs and asks for missing client credentials', async () => {
    const base = config();
    const googleConfig: SetupConfig = {
      ...base,
      providers: {
        ...base.providers,
        oauth: { ...base.providers.oauth, google: { enabled: true } },
      },
    };
    const step = (
      await buildNextSteps({ config: googleConfig, dnsRecords: records, checks: checks() })
    ).find((entry) => entry.title.startsWith('Register the sign-in callback URLs'));
    expect(step?.status).toBe('todo');
    expect(step?.lines).toContainEqual('  production: https://app.acme.test/callback/google');
    expect(step?.lines).toContainEqual(
      expect.stringMatching(/^✗ development: OAUTH_GOOGLE_CLIENT_ID/),
    );
  });

  it('raises the attestation decision only for a private backend repository', async () => {
    const titles = async (isPrivate: boolean) =>
      (
        await buildNextSteps({
          config: config(),
          dnsRecords: records,
          checks: checks({ repositoryIsPrivate: async () => isPrivate }),
        })
      ).map((step) => step.title);
    expect(await titles(true)).toContainEqual(expect.stringMatching(/attestations/));
    expect(await titles(false)).not.toContainEqual(expect.stringMatching(/attestations/));
  });
});

describe('DNS requirements', () => {
  it('normalises Railway record types and ignores duplicates', () => {
    expect(plainDnsType('DNS_RECORD_TYPE_CNAME')).toBe('CNAME');
    expect(plainDnsType('A')).toBeUndefined();
    const record: DnsRequirement = {
      provider: 'Netlify',
      type: 'CNAME',
      name: 'dup.acme.test',
      value: 'v',
    };
    requireDnsRecord(record);
    requireDnsRecord({ ...record, name: 'DUP.acme.test' });
    expect(collectedDnsRequirements().filter((entry) => entry.value === 'v')).toHaveLength(1);
  });

  it('forgets saved records that no longer belong to the domain', () => {
    const stale = { provider: 'Railway', type: 'CNAME', name: 'api.old.test', value: 'x' } as const;
    expect(mergeDnsRequirements([...records, stale], [], 'acme.test')).toEqual(records);
  });

  it('keeps saved records a failed provider did not report, and lets fresh values win', () => {
    const merged = mergeDnsRequirements(records, [
      { provider: 'Netlify', type: 'CNAME', name: 'APP.acme.test', value: 'new-fe.netlify.app' },
    ]);
    expect(merged).toEqual([
      { provider: 'Netlify', type: 'CNAME', name: 'APP.acme.test', value: 'new-fe.netlify.app' },
      records[1],
    ]);
  });
});

describe('backend database users', () => {
  it("names the backend's roles after the project", () => {
    expect(backendRoleName(config(), 'app')).toBe('acme_be_app');
    expect(backendRoleName(config(), 'maintenance')).toBe('acme_be_maintenance');
    expect(backendRoleName(config(), 'migrator')).toBe('acme_be_migrator');
  });

  it('reuses a password only from a URL that logs in as that user', () => {
    expect(
      passwordFromEnvUrl('postgresql://acme_be_migrator:pw_1-x@h/db', 'acme_be_migrator'),
    ).toBe('pw_1-x');
    expect(
      passwordFromEnvUrl('postgresql://neondb_owner:pw@h/db', 'acme_be_migrator'),
    ).toBeUndefined();
    expect(
      passwordFromEnvUrl('postgresql://acme_be_migrator:bad%27pw@h/db', 'acme_be_migrator'),
    ).toBe(undefined); // characters the SQL path cannot inline are never reused
    expect(passwordFromEnvUrl(undefined, 'x')).toBeUndefined();
  });
});
