/**
 * GitHub Environment sync: values carrying credentials must ship as Secrets, never as readable
 * Variables. Every `DATABASE_*_URL` embeds a password.
 */
import { describe, expect, it } from 'vitest';
import { classifyKey } from '@setup/github/sync-github-environments.js';

describe('classifyKey', () => {
  it('ships every database connection string as a secret', () => {
    for (const key of [
      'DATABASE_URL',
      'DATABASE_MIGRATION_URL',
      'DATABASE_MAINTENANCE_URL',
      'DATABASE_OPERATOR_URL',
    ]) {
      expect(classifyKey(key), key).toBe('secret');
    }
  });

  it('keeps public URLs as variables', () => {
    expect(classifyKey('FRONTEND_URL')).toBe('variable');
  });
});
