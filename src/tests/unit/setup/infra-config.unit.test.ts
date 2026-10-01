import { describe, expect, it } from 'vitest';
import type { InfraProvider } from '@setup/common/types.js';
import { defineInfraConfig } from '@setup/infra/config.js';
import { getInfraProviders } from '@setup/infra/providers/index.js';
import { resendPreset } from '@setup/presets/index.js';

const envFiles = {
  backend: (env: string) => `.env.${env}`,
  frontend: (env: string) => `.env.${env}`,
};

// A minimal stand-in bespoke provider (only the fields the resolver touches).
const fakeProvider = {
  key: 'fake',
  name: 'Fake',
  isEnabled: () => true,
  disabledReason: () => '',
  buildStep: () => ({
    name: 'Fake',
    enabled: true,
    enabledReason: '',
    instructions: [],
    execute: async () => ({ success: true, message: 'ok' }),
  }),
} as unknown as InfraProvider;

describe('defineInfraConfig', () => {
  it('normalizes presets to providers and passes bespoke providers through, preserving order', () => {
    const resolved = defineInfraConfig({
      envFiles,
      resources: () => [fakeProvider, resendPreset],
    });
    expect(resolved.providers.map((p) => p.key)).toEqual(['fake', 'resend']);
    // The preset was turned into a real InfraProvider with a buildStep.
    expect(typeof resolved.providers[1]?.buildStep).toBe('function');
  });

  it('removing a resource line removes it from the resolved provider list', () => {
    const full = defineInfraConfig({ envFiles, resources: () => [fakeProvider, resendPreset] });
    const trimmed = defineInfraConfig({ envFiles, resources: () => [fakeProvider] });
    expect(full.providers).toHaveLength(2);
    expect(trimmed.providers).toHaveLength(1);
    expect(trimmed.providers.map((p) => p.key)).toEqual(['fake']);
  });

  it('exposes the env-file mappers per target', () => {
    const resolved = defineInfraConfig({ envFiles, resources: () => [] });
    expect(resolved.envFiles.backend('development')).toBe('.env.development');
    expect(resolved.envFiles.frontend('production')).toBe('.env.production');
  });
});

describe('provider list (sourced from infra.config.ts)', () => {
  it('is populated from the root config with unique keys', () => {
    const providers = getInfraProviders();
    expect(providers.length).toBeGreaterThan(0);
    const keys = providers.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('includes the converted presets and managed providers', () => {
    const keys = getInfraProviders().map((p) => p.key);
    expect(keys).toContain('resend'); // validate preset
    expect(keys).toContain('neon'); // managed preset
  });
});
