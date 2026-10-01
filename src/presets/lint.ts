/**
 * Preset lint — the mechanical guard that keeps presets well-formed (Task 7).
 *
 * Rules:
 *  - every preset declares an `outputs` array (use [] for services that emit no env vars);
 *  - output keys are UPPER_SNAKE_CASE and unique within the preset;
 *  - every declared output is emitted into the generated `.env.example`;
 *  - guide presets collect ≥1 field, every field is a declared output, and have
 *    non-empty instructions (the clinozy-infra analogue of a `manual` preset's `steps`);
 *  - validate presets expose a `validate()`; managed presets wrap a provider whose key matches.
 */
import { buildEnvExample } from './example.js';
import type { Preset } from './types.js';

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** Lint a single preset. Returns human-readable problems (empty array = OK). */
export function lintPreset(preset: Preset): string[] {
  const errors: string[] = [];
  const label = preset.key || '(missing key)';

  if (!preset.key) errors.push('preset is missing a key');
  if (!preset.name) errors.push(`${label}: missing name`);

  if (!Array.isArray(preset.outputs)) {
    errors.push(`${label}: must declare an outputs array (use [] if it emits no env vars)`);
  } else {
    const seen = new Set<string>();
    for (const output of preset.outputs) {
      if (!output.key || !ENV_KEY_RE.test(output.key)) {
        errors.push(`${label}: invalid output key "${output.key}" (expected UPPER_SNAKE_CASE)`);
      }
      if (seen.has(output.key)) errors.push(`${label}: duplicate output key "${output.key}"`);
      seen.add(output.key);
    }
    const example = buildEnvExample([preset]);
    for (const output of preset.outputs) {
      if (output.key && !example.includes(`${output.key}=`)) {
        errors.push(`${label}: output "${output.key}" is not emitted into .env.example`);
      }
    }
  }

  if (preset.kind === 'guide') {
    if (preset.guide.fields.length === 0) errors.push(`${label}: guide preset collects no fields`);
    const outputKeys = new Set((preset.outputs ?? []).map((o) => o.key));
    for (const field of preset.guide.fields) {
      if (!outputKeys.has(field.key)) {
        errors.push(`${label}: guide field "${field.key}" is not a declared output`);
      }
    }
    const hasInstructions =
      typeof preset.instructions === 'function' || preset.instructions.length > 0;
    if (!hasInstructions) errors.push(`${label}: guide preset has empty instructions`);
  } else if (preset.kind === 'validate') {
    if (typeof preset.validate !== 'function') {
      errors.push(`${label}: validate preset has no validate()`);
    }
  } else if (!preset.provider || preset.provider.key !== preset.key) {
    errors.push(`${label}: managed preset must wrap a provider whose key matches`);
  }

  return errors;
}

/** Lint the whole catalog. Returns key → problems only for presets with problems. */
export function lintPresets(presets: readonly Preset[]): Record<string, string[]> {
  const report: Record<string, string[]> = {};
  const seenKeys = new Set<string>();
  for (const preset of presets) {
    const errors = lintPreset(preset);
    if (seenKeys.has(preset.key)) errors.push(`${preset.key}: duplicate preset key in catalog`);
    seenKeys.add(preset.key);
    if (errors.length) report[preset.key] = errors;
  }
  return report;
}
