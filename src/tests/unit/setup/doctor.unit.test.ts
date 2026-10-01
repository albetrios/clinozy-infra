import { describe, expect, it } from 'vitest';
import type { SetupConfig } from '@setup/common/types.js';
import { runDoctorChecks } from '@setup/infra/doctor.js';
import { PRESETS } from '@setup/presets/index.js';
import type { Preset } from '@setup/presets/index.js';

function config(overrides: Record<string, unknown>): SetupConfig {
  const base = {
    project: { name: 'clinozy-be', displayName: 'clinozy-be', organization: 'albetrios' },
    frontend: { name: 'clinozy-fe', url: { development: 'http://localhost:5173', production: '' } },
    environments: [
      { name: 'development', nodeEnvironment: 'development', deployBranch: 'dev', protected: true },
      { name: 'production', nodeEnvironment: 'production', deployBranch: 'main', protected: true },
    ],
    providers: { oauth: { google: { enabled: false }, github: { enabled: false } } },
    app: {
      frontendUrl: { development: 'http://localhost:3000', production: 'https://api.example.com' },
    },
  };
  return { ...base, ...overrides } as unknown as SetupConfig;
}

describe('runDoctorChecks', () => {
  it('reports no errors for the real preset catalog with a healthy config', () => {
    const diagnostics = runDoctorChecks(config({}), PRESETS);
    expect(diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });

  it('catches a deliberately broken config: OAuth enabled but no frontend origin', () => {
    const broken = config({
      providers: { oauth: { google: { enabled: true }, github: { enabled: false } } },
    });
    const diagnostics = runDoctorChecks(broken, PRESETS);
    // production has no frontend.url → redirect URIs can't be derived; development is configured.
    expect(
      diagnostics.some((d) => /OAuth enabled but frontend.url.production/.test(d.message)),
    ).toBe(true);
    expect(
      diagnostics.some((d) => /OAuth enabled but frontend.url.development/.test(d.message)),
    ).toBe(false);
  });

  it('flags production environments with an empty public frontend URL', () => {
    const diagnostics = runDoctorChecks(config({}), PRESETS);
    expect(diagnostics.some((d) => /frontend.url.production is empty/.test(d.message))).toBe(true);
  });

  it('warns when two presets declare the same output key', () => {
    const dupA = {
      kind: 'managed',
      key: 'a',
      name: 'A',
      provider: { key: 'a' },
      outputs: [{ key: 'SHARED' }],
    };
    const dupB = {
      kind: 'managed',
      key: 'b',
      name: 'B',
      provider: { key: 'b' },
      outputs: [{ key: 'SHARED' }],
    };
    const presets = [dupA, dupB] as unknown as Preset[];
    const diagnostics = runDoctorChecks(config({}), presets);
    expect(diagnostics.some((d) => /SHARED.*declared by both/.test(d.message))).toBe(true);
  });
});
