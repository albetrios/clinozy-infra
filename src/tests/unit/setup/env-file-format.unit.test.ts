import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';
import { escapeEnvValue } from '@setup/envs/env-file-format.util.js';

describe('escapeEnvValue round-trip', () => {
  // The value classes real provisioned secrets take: connection URLs, tokens, PEM blocks, values
  // with spaces / `#` / apostrophes. (Single-line values with a bare `"` or `\` are NOT a supported
  // round-trip case — dotenv does not unescape them — but real secrets never contain those.)
  for (const value of [
    'simple',
    'postgres://user:p@ss@host:5432/db?sslmode=require',
    'with spaces',
    'has#hash',
    "apostrophe'inside",
    '-----BEGIN KEY-----\nabc/def+ghi==\n-----END KEY-----',
    'line1\nline2',
    '',
  ]) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      const parsed = dotenv.parse(`K=${escapeEnvValue(value)}`);
      expect(parsed.K ?? '').toBe(value);
    });
  }
});
