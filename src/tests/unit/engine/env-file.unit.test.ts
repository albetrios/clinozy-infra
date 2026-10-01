import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv, upsertEnv } from '@setup/engine/index.js';

function tmpEnv(initial: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'clinozy-infra-envfile-'));
  const p = join(dir, '.env');
  writeFileSync(p, initial);
  return p;
}

describe('parseEnv', () => {
  it('parses keys, strips surrounding quotes, ignores comments and blanks', () => {
    const parsed = parseEnv('# a comment\n\nFOO=bar\nexport BAZ="quoted value"\nQUX=\n');
    expect(parsed).toEqual({ FOO: 'bar', BAZ: 'quoted value', QUX: '' });
  });
});

describe('upsertEnv', () => {
  it('updates existing keys in place and appends new keys under a managed block', () => {
    const p = tmpEnv('# top comment\nFOO=old\n\nCUSTOM=keep\n');
    const { changed, added } = upsertEnv(p, { FOO: 'new', BAR: 'added' });
    const out = readFileSync(p, 'utf8');

    expect(changed).toEqual(['FOO']);
    expect(added).toEqual(['BAR']);
    // Unrelated content is preserved.
    expect(out).toContain('# top comment');
    expect(out).toContain('CUSTOM=keep');
    // Existing key updated in place (still before the managed block).
    expect(out.indexOf('FOO=new')).toBeLessThan(out.indexOf('# --- managed by clinozy-infra ---'));
    // New key appended under the managed block.
    expect(out).toContain('BAR=added');
  });

  it('quotes values that need it', () => {
    const p = tmpEnv('');
    upsertEnv(p, { WITH_SPACE: 'a b c' });
    expect(readFileSync(p, 'utf8')).toContain('WITH_SPACE="a b c"');
  });

  it('is idempotent — re-running with the same values is a no-op', () => {
    const p = tmpEnv('FOO=bar\n');
    upsertEnv(p, { FOO: 'bar' });
    const first = readFileSync(p, 'utf8');
    upsertEnv(p, { FOO: 'bar' });
    expect(readFileSync(p, 'utf8')).toBe(first);
  });

  it('replaces a multi-line quoted value without orphaning its continuation lines', () => {
    // The engine's default formatter double-quotes multi-line values.
    const p = tmpEnv('K="line-a\nline-b\nline-c"\nAFTER=here\n');
    upsertEnv(p, { K: 'single' });
    const out = readFileSync(p, 'utf8');
    expect(out).toContain('K=single');
    expect(out).not.toContain('line-b');
    expect(out).toContain('AFTER=here');
  });
});
