import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';
import { upsertEnvContent } from '@setup/engine/index.js';
import { escapeEnvValue } from '@setup/envs/env-file-format.util.js';

/** Exactly what both env writers do: surgical upsert with clinozy-infra's value formatter. */
const upsert = (text: string, updates: Record<string, string>): string =>
  upsertEnvContent(text, updates, escapeEnvValue).text;

describe('surgical .env upsert (export path)', () => {
  it('round-trips a file with comments and custom keys, changing only provisioned keys', () => {
    const original = [
      '# Backend env for clinozy-be',
      '',
      '# Database',
      'DATABASE_URL=',
      'REDIS_URL=',
      '',
      '# My own local override — must survive',
      'MY_CUSTOM_FLAG=keep-me',
      'DEBUG_SQL=true',
      '',
    ].join('\n');

    const out = upsert(original, { DATABASE_URL: 'postgres://db', REDIS_URL: 'redis://cache' });

    // Provisioned keys updated in place.
    expect(out).toContain('DATABASE_URL=postgres://db');
    expect(out).toContain('REDIS_URL=redis://cache');
    // Every unrelated line preserved verbatim (comments + custom keys).
    expect(out).toContain('# Backend env for clinozy-be');
    expect(out).toContain('# Database');
    expect(out).toContain('# My own local override — must survive');
    expect(out).toContain('MY_CUSTOM_FLAG=keep-me');
    expect(out).toContain('DEBUG_SQL=true');
    // Order preserved.
    expect(out.indexOf('DATABASE_URL')).toBeLessThan(out.indexOf('MY_CUSTOM_FLAG'));
    // All updates matched existing keys — no managed block appended.
    expect(out).not.toContain('managed by clinozy-infra');
  });

  it('appends genuinely new keys under one managed block, preserving the rest', () => {
    const original = '# top\nDATABASE_URL=postgres://db\n';
    const out = upsert(original, { CAPTCHA_SITE_KEY: '0xAAA', POSTMAN_WORKSPACE_ID: 'ws-1' });
    expect(out).toContain('# top');
    expect(out).toContain('DATABASE_URL=postgres://db');
    expect(out).toContain('# --- managed by clinozy-infra ---');
    expect(out).toContain('CAPTCHA_SITE_KEY=0xAAA');
    expect(out).toContain('POSTMAN_WORKSPACE_ID=ws-1');
  });

  it('preserves an existing multi-line PEM value that is not being updated', () => {
    const pem = '-----BEGIN KEY-----\nabc/def+ghi\n-----END KEY-----';
    const original = `JWT_PRIVATE_KEY=${escapeEnvValue(pem)}\nLOG_LEVEL=info\n`;
    const out = upsert(original, { LOG_LEVEL: 'debug' });
    expect(dotenv.parse(out).JWT_PRIVATE_KEY).toBe(pem);
    expect(out).toContain('LOG_LEVEL=debug');
  });

  it('replaces a multi-line PEM value in place without orphaning continuation lines', () => {
    const oldPem = '-----BEGIN KEY-----\nold-line-1\nold-line-2\n-----END KEY-----';
    const newPem = '-----BEGIN KEY-----\nnew-only\n-----END KEY-----';
    const original = `# keys\nJWT_PRIVATE_KEY=${escapeEnvValue(oldPem)}\nAFTER=here\n`;
    const out = upsert(original, { JWT_PRIVATE_KEY: newPem });
    expect(dotenv.parse(out).JWT_PRIVATE_KEY).toBe(newPem);
    // The old PEM body is gone — no orphaned continuation line.
    expect(out).not.toContain('old-line-2');
    // Trailing key preserved.
    expect(dotenv.parse(out).AFTER).toBe('here');
  });

  it('is a no-op when there are no fresh values (never blanks an existing secret)', () => {
    const original = 'DATABASE_URL=postgres://existing\nLOG_LEVEL=info\n';
    expect(upsert(original, {})).toBe(original);
  });
});
