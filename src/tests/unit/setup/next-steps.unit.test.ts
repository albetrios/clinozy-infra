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
import { type NextStepChecks, buildNextSteps } from '@setup/infra/next-steps.js';
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

  it('marks the database users done only with a maintenance URL and the migrator login', async () => {
    const done = await buildNextSteps({ config: config(), dnsRecords: records, checks: checks() });
    expect(done.find((step) => step.title.startsWith('Backend database users'))?.status).toBe(
      'done',
    );
    const bootstrapOnly = await buildNextSteps({
      config: config(),
      dnsRecords: records,
      checks: checks({
        envValue: (_environment, key) =>
          key === 'DATABASE_MIGRATION_URL' ? 'postgresql://neondb_owner:pw@h/db' : undefined,
      }),
    });
    expect(
      bootstrapOnly.find((step) => step.title.startsWith('Backend database users'))?.status,
    ).toBe('todo');
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
