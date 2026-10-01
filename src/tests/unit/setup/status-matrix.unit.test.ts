import { describe, expect, it } from 'vitest';
import type { GuideData } from '@setup/infra/setup-guide/data.js';
import { buildStatusMatrix } from '@setup/infra/status-matrix.js';
import { slotNote } from '@setup/integrations/keystash.js';

// Guide data as produced by withStatus() — two envs, three services.
const data: GuideData = {
  project: 'clinozy-be',
  credsFile: '.setup/.setup-credentials',
  environments: ['development', 'production'],
  services: [
    {
      name: 'Neon',
      kind: 'managed',
      group: 'account',
      credentials: ['NEON_API_KEY'],
      outputs: ['DATABASE_URL'],
      feKeys: [],
      steps: [],
      status: { development: 'complete', production: 'missing' },
    },
    {
      name: 'AWS',
      kind: 'managed',
      group: 'account',
      credentials: [],
      outputs: ['S3_BUCKET', 'S3_REGION'],
      feKeys: [],
      steps: [],
      status: { development: 'partial', production: 'missing' },
    },
    {
      name: 'JWT',
      kind: 'managed',
      group: 'auto',
      credentials: [],
      outputs: ['JWT_SECRET'],
      feKeys: [],
      steps: [],
      status: { development: 'complete', production: 'complete' },
    },
  ],
};

describe('buildStatusMatrix', () => {
  it('maps complete/partial/missing into set/partial/missing cells per env', () => {
    const m = buildStatusMatrix(data);
    expect(m.environments).toEqual(['development', 'production']);
    const neon = m.rows.find((r) => r.name === 'Neon');
    expect(neon?.cells).toEqual({ development: 'set', production: 'missing' });
    const aws = m.rows.find((r) => r.name === 'AWS');
    expect(aws?.cells.development).toBe('partial');
  });

  it('marks a cell "vaulted" when all of a service\'s outputs are in the vault for that env', () => {
    const vaulted = new Set([`JWT_SECRET::${slotNote('clinozy-be', '.env.development')}`]);
    const m = buildStatusMatrix(data, { vaulted, project: 'clinozy-be' });
    const jwt = m.rows.find((r) => r.name === 'JWT');
    expect(jwt?.cells.development).toBe('vaulted'); // all outputs vaulted for dev
    expect(jwt?.cells.production).toBe('set'); // not vaulted for prod → falls back to set
  });
});
