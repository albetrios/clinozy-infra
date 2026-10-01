import { describe, expect, it } from 'vitest';
import type { ManagedPreset, ValidatePreset } from '@setup/presets/index.js';
import { PRESETS, buildEnvExample, lintPreset, lintPresets } from '@setup/presets/index.js';

describe('preset lint', () => {
  it('the whole catalog is clean', () => {
    expect(lintPresets(PRESETS)).toEqual({});
  });

  it('fails a preset with no declared outputs', () => {
    const [first] = PRESETS;
    const broken = { ...first, outputs: undefined } as unknown as ManagedPreset;
    expect(lintPreset(broken).join(' ')).toMatch(/must declare an outputs array/);
  });

  it('fails a managed preset whose wrapped provider key does not match', () => {
    const managed = PRESETS.find((p) => p.kind === 'managed') as ManagedPreset;
    const broken = { ...managed, key: 'mismatched' } as ManagedPreset;
    expect(lintPreset(broken).join(' ')).toMatch(/provider whose key matches/);
  });

  it('fails a validate preset missing validate()', () => {
    const validate = PRESETS.find((p) => p.kind === 'validate') as ValidatePreset;
    const broken = { ...validate, validate: undefined } as unknown as ValidatePreset;
    expect(lintPreset(broken).join(' ')).toMatch(/no validate\(\)/);
  });
});

describe('buildEnvExample', () => {
  it('emits every declared output key for every preset', () => {
    const example = buildEnvExample(PRESETS);
    for (const preset of PRESETS) {
      for (const output of preset.outputs ?? []) {
        expect(example).toContain(`${output.key}=`);
      }
    }
  });

  it('carries no real values (safe to commit)', () => {
    const example = buildEnvExample(PRESETS);
    // Every non-comment line is a bare `KEY=` with nothing after the equals.
    for (const line of example.split('\n')) {
      if (line.startsWith('#') || line === '') continue;
      expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }
  });
});
