import { describe, expect, it } from 'vitest';
import type { InfraProviderContext, SetupConfig } from '@setup/common/types.js';
import {
  neonEnvironmentNames,
  setupNeonProvider,
} from '@setup/infra/providers/setup-neon/setup-neon.provider.js';

const POOLED =
  'postgresql://svc:pw@ep-x-pooler.c-3.us-east-2.aws.neon.tech/clinozy_be_development?sslmode=require';
const DIRECT =
  'postgresql://owner:pw@ep-x.c-3.us-east-2.aws.neon.tech/clinozy_be_development?sslmode=require';

function envVars(
  project: { databaseUrl: string; databaseMigrationUrl?: string } | undefined,
  neonApiKey = '',
) {
  const context = {
    config: { providers: { neon: { enabled: true } } },
    secrets: { neon: { apiKey: neonApiKey } },
    state: { neon: { projects: project ? { development: project } : {} } },
  } as unknown as InfraProviderContext;
  return setupNeonProvider.toEnvironmentVariables?.(context, 'development');
}

describe('setupNeonProvider.toEnvironmentVariables', () => {
  it('writes DATABASE_URL (pooled) and DATABASE_MIGRATION_URL (direct) when both are recorded', () => {
    expect(envVars({ databaseUrl: POOLED, databaseMigrationUrl: DIRECT })).toEqual({
      DATABASE_URL: POOLED,
      DATABASE_MIGRATION_URL: DIRECT,
    });
  });

  it('NEVER falls back to the pooled databaseUrl for DATABASE_MIGRATION_URL — omits the key instead', () => {
    // Regression guard: a pooler DATABASE_MIGRATION_URL is exactly what migrate.ts rejects (the
    // migration advisory lock needs a session pinned to one backend). Omitting is safer than writing
    // a knowingly-broken value; re-provisioning captures the real direct URL.
    const result = envVars({ databaseUrl: POOLED });
    expect(result).toEqual({ DATABASE_URL: POOLED });
    expect(result).not.toHaveProperty('DATABASE_MIGRATION_URL');
    expect(result?.DATABASE_MIGRATION_URL).toBeUndefined();
  });

  it('returns {} when the environment has no Neon project', () => {
    expect(envVars(undefined)).toEqual({});
  });

  it('hands the restore drill its Neon key, with or without a recorded project', () => {
    expect(envVars(undefined, 'fake-neon-key')).toEqual({
      MONTHLY_DATABASE_RESTORE_DRILL_NEON_API_KEY: 'fake-neon-key',
    });
    expect(envVars({ databaseUrl: POOLED }, 'fake-neon-key')).toMatchObject({
      DATABASE_URL: POOLED,
      MONTHLY_DATABASE_RESTORE_DRILL_NEON_API_KEY: 'fake-neon-key',
    });
  });
});

describe('neonEnvironmentNames', () => {
  const config = {
    project: { name: 'clinozy-be' },
    environments: [{ name: 'development' }, { name: 'production' }],
  } as unknown as SetupConfig;

  it('derives every Neon name from the project and environment — never Neon defaults', () => {
    expect(neonEnvironmentNames(config, 'production')).toEqual({
      projectName: 'clinozy-be-production',
      branchName: 'production',
      databaseName: 'clinozy_be_production',
      ownerRoleName: 'clinozy_be_production_owner',
    });
    expect(neonEnvironmentNames(config, 'development')).toEqual({
      projectName: 'clinozy-be-development',
      branchName: 'development',
      databaseName: 'clinozy_be_development',
      ownerRoleName: 'clinozy_be_development_owner',
    });
  });

  it('keeps the database owner apart from the backend-managed `<project>_owner` group role', () => {
    // The backend's migrations own and may recreate `clinozy_be_owner`; Neon's admin must never be it.
    expect(neonEnvironmentNames(config, 'production').ownerRoleName).not.toBe('clinozy_be_owner');
  });

  it('rejects an environment missing from setup.config.json', () => {
    expect(() => neonEnvironmentNames(config, 'staging')).toThrow(/Unknown environment "staging"/);
  });
});
