import { describe, expect, it } from 'vitest';
import { presetExportName, renderInfraConfigTs } from '@setup/infra/scaffold-config.js';
import { PRESETS } from '@setup/presets/index.js';

describe('presetExportName', () => {
  it('maps kebab-case keys to their exported binding name', () => {
    expect(presetExportName('neon')).toBe('neonPreset');
    expect(presetExportName('google-oauth')).toBe('googleOauthPreset');
    expect(presetExportName('github-app-with-oauth')).toBe('githubAppWithOauthPreset');
    expect(presetExportName('railway-redis')).toBe('railwayRedisPreset');
  });
});

describe('renderInfraConfigTs', () => {
  const ts = renderInfraConfigTs(PRESETS);

  it('imports defineInfraConfig and every preset, and lists them as resources', () => {
    expect(ts).toContain("import { defineInfraConfig } from './src/infra/infra-config.js';");
    expect(ts).toContain('export default defineInfraConfig(');
    expect(ts).toContain('resources: () => [');
    for (const preset of PRESETS) {
      expect(ts).toContain(presetExportName(preset.key));
    }
  });

  it('emits the env-file mappers for both targets', () => {
    expect(ts).toContain('backend: (env) => `.env.${env}`');
    expect(ts).toContain('frontend: (env) => `.env.${env}`');
  });
});
