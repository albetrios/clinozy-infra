/**
 * Generate committable `.env.example` content (keys + comments, NO values) from the
 * preset catalog. Used by the preset-lint check (Task 7) and the `example` CLI verb
 * (Task 5). Grouped by preset so a reader sees which service owns each key.
 */
import type { Preset } from './types.js';

export function buildEnvExample(presets: readonly Preset[]): string {
  const lines: string[] = [
    '# .env.example — generated from infra.config.ts presets.',
    '# Copy to .env.<environment> and fill in values. Never commit real secrets.',
    '',
  ];
  for (const preset of presets) {
    lines.push(`# ── ${preset.name} (${preset.key}) ──`);
    const outputs = preset.outputs ?? [];
    if (outputs.length === 0) {
      lines.push('#   (no runtime env vars)');
    } else {
      for (const output of outputs) {
        if (output.description) lines.push(`# ${output.description}`);
        lines.push(`${output.key}=`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
