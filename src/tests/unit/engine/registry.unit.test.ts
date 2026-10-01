import { describe, expect, it } from 'vitest';
import { getProvider, registeredProviders } from '@setup/engine/index.js';

const BUILT_INS = ['httpApi', 'manual', 'generate', 'static', 'mock'];

describe('provider registry', () => {
  it('resolves every built-in generic provider by name', () => {
    for (const name of BUILT_INS) {
      expect(getProvider(name).name).toBe(name);
    }
  });

  it('lists all registered providers', () => {
    expect(registeredProviders()).toEqual(expect.arrayContaining(BUILT_INS));
  });

  it('throws a helpful error for an unknown provider', () => {
    expect(() => getProvider('nope')).toThrow(/Unknown provider "nope"/);
  });
});
