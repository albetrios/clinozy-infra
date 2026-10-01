import { describe, expect, it } from 'vitest';
import type { InfraProviderContext } from '@setup/common/types.js';
import { setupNeonProvider } from '@setup/infra/providers/setup-neon/setup-neon.provider.js';

const POOLED = 'postgresql://svc:pw@ep-x-pooler.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require';
const DIRECT = 'postgresql://owner:pw@ep-x.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require';

function envVars(branch: { databaseUrl: string; databaseMigrationUrl?: string } | undefined) {
  const context = {
    state: { neon: { branches: branch ? { development: branch } : {} } },
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

  it('returns {} when the environment has no Neon branch', () => {
    expect(envVars(undefined)).toEqual({});
  });
});
