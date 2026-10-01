import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getInfraProviders } from '@setup/infra/providers/index.js';

/**
 * Drift guard: every registered setup:infra provider key must be documented in the README's
 * provider list. Catches the kind of staleness a provider add/remove/rename otherwise leaves
 * behind (e.g. `github-oauth` → `github-app-with-oauth`).
 */
const README = readFileSync(resolve(process.cwd(), 'docs/SETUP_INFRA_README.md'), 'utf-8');

describe('setup:infra provider docs are in sync', () => {
  it('every provider key is listed in SETUP_INFRA_README.md', () => {
    const missing = getInfraProviders()
      .map((provider) => provider.key)
      .filter((key) => !README.includes(`\`${key}\``));
    expect(missing).toEqual([]);
  });

  it('no provider key collides with another', () => {
    const keys = getInfraProviders().map((provider) => provider.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
