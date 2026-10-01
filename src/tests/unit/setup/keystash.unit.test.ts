import { describe, expect, it } from 'vitest';
import {
  KeyStash,
  type KeyStashBackend,
  type Store,
  slotNote,
} from '@setup/integrations/keystash.js';

interface FakeBackend extends KeyStashBackend {
  keychain: Array<{ service: string; account: string; value: string }>;
  saved: Store[];
  store: Store;
}

function fakeBackend(overrides: Partial<KeyStashBackend> = {}): FakeBackend {
  let counter = 0;
  const state: FakeBackend = {
    keychain: [],
    saved: [],
    store: { keys: [], projects: [], mappings: [] },
    writeKeychain(service, account, value) {
      state.keychain.push({ service, account, value });
    },
    loadStore() {
      return state.store;
    },
    saveStore(_p, store) {
      state.store = store;
      state.saved.push(store);
    },
    platform: () => 'darwin',
    now: () => 1_700_000_000_000,
    uuid: () => `uuid-${++counter}`,
    ...overrides,
  };
  return state;
}

const opts = { storePath: '/tmp/store.json', service: 'test.svc' };

function input(name: string, value: string) {
  return {
    name,
    provider: 'Resend',
    note: slotNote('clinozy-be', '.env.development'),
    value,
    projectName: 'clinozy-be',
    projectPath: '/repo/clinozy-be',
    envVar: name,
  };
}

describe('KeyStash.vault', () => {
  it('adds a new key, writes the Keychain, and records project + mapping', () => {
    const be = fakeBackend();
    const ks = new KeyStash(opts, be);
    expect(ks.vault(input('RESEND_API_KEY', 're_123'))).toBe('added');

    expect(be.store.keys).toHaveLength(1);
    expect(be.store.projects).toHaveLength(1);
    expect(be.store.mappings).toHaveLength(1);
    // uuid-1 is the project id; uuid-2 is the key id (the Keychain account).
    expect(be.keychain).toEqual([{ service: 'test.svc', account: 'uuid-2', value: 're_123' }]);
    expect(be.store.mappings[0]).toMatchObject({ env_var: 'RESEND_API_KEY' });
  });

  it('updates the same (name, note) slot in place instead of duplicating', () => {
    const be = fakeBackend();
    const ks = new KeyStash(opts, be);
    ks.vault(input('RESEND_API_KEY', 're_123'));
    expect(ks.vault(input('RESEND_API_KEY', 're_456'))).toBe('updated');

    expect(be.store.keys).toHaveLength(1); // no duplicate
    expect(be.keychain.at(-1)?.value).toBe('re_456'); // value updated in Keychain
  });

  it('dedupes projects by path', () => {
    const be = fakeBackend();
    const ks = new KeyStash(opts, be);
    ks.vault(input('A', '1'));
    ks.vault(input('B', '2'));
    expect(be.store.projects).toHaveLength(1);
  });

  it('exposes vaulted slots as name::note', () => {
    const be = fakeBackend();
    const ks = new KeyStash(opts, be);
    ks.vault(input('RESEND_API_KEY', 're_1'));
    expect(
      ks.vaultedSlots().has(`RESEND_API_KEY::${slotNote('clinozy-be', '.env.development')}`),
    ).toBe(true);
  });

  it('skips the Keychain write when skipKeychain is set (metadata only)', () => {
    const be = fakeBackend();
    const ks = new KeyStash({ ...opts, skipKeychain: true }, be);
    ks.vault(input('A', '1'));
    expect(be.keychain).toHaveLength(0);
    expect(be.store.keys).toHaveLength(1);
  });

  it('refuses to run off macOS unless the Keychain write is skipped', () => {
    const be = fakeBackend({ platform: () => 'linux' });
    expect(() => new KeyStash(opts, be)).toThrow(/requires macOS/);
    // …but works with skipKeychain (CI / non-mac).
    expect(() => new KeyStash({ ...opts, skipKeychain: true }, be)).not.toThrow();
  });
});
