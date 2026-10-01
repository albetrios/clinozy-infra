import { describe, expect, it } from 'vitest';
import { resolveClearSeconds } from '@setup/infra/output.js';

describe('resolveClearSeconds (clipboard auto-clear window)', () => {
  it('defaults to 30s when unset or not a finite number', () => {
    expect(resolveClearSeconds()).toBe(30);
    expect(resolveClearSeconds(Number.NaN)).toBe(30);
    expect(resolveClearSeconds(Number.POSITIVE_INFINITY)).toBe(30);
  });

  it('honours an explicit window', () => {
    expect(resolveClearSeconds(45)).toBe(45);
    expect(resolveClearSeconds(10)).toBe(10);
  });

  it('clamps to a safe range (5s..300s) and rounds', () => {
    expect(resolveClearSeconds(1)).toBe(5);
    expect(resolveClearSeconds(9999)).toBe(300);
    expect(resolveClearSeconds(12.7)).toBe(13);
  });
});
