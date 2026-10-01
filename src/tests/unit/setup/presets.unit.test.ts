import { describe, expect, it } from 'vitest';
import { PRESETS, presetToProvider } from '@setup/presets/index.js';

describe('preset catalog', () => {
  it('every preset has a key, a name, and the right surface for its kind', () => {
    for (const preset of PRESETS) {
      expect(preset.key).toBeTruthy();
      expect(preset.name).toBeTruthy();
      if (preset.kind === 'guide') {
        // Guide presets must collect at least one field.
        expect(preset.guide.fields.length).toBeGreaterThan(0);
      } else if (preset.kind === 'validate') {
        // Validate presets must expose a validate() (also run by --check).
        expect(typeof preset.validate).toBe('function');
      } else {
        // Managed presets wrap a retained provider with a matching key.
        expect(preset.provider.key).toBe(preset.key);
      }
    }
  });

  it('declared outputs are unique within a preset', () => {
    for (const preset of PRESETS) {
      const keys = (preset.outputs ?? []).map((o) => o.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('presetToProvider preserves the key and produces a buildStep + isEnabled', () => {
    for (const preset of PRESETS) {
      const provider = presetToProvider(preset);
      expect(provider.key).toBe(preset.key);
      expect(typeof provider.buildStep).toBe('function');
      expect(typeof provider.isEnabled).toBe('function');
    }
  });

  it('guide presets report a guide-only inspectRemote (no fake remote resource)', async () => {
    const context = {
      config: { providers: { stripe: { enabled: true }, oauth: { google: { enabled: true } } } },
      secrets: {},
      state: {},
      environments: ['development'],
      applyStateUpdates: () => {},
    } as unknown as Parameters<ReturnType<typeof presetToProvider>['isEnabled']>[0];

    for (const preset of PRESETS) {
      if (preset.kind !== 'guide') continue;
      const provider = presetToProvider(preset);
      const inspection = await provider.inspectRemote?.(context);
      expect(inspection?.present).toBe(false);
      expect(inspection?.error).toMatch(/guide-only/);
    }
  });
});
