import { describe, expect, it } from 'vitest';
import {
  buildEnvSetupTemplateContent,
  credentialUrl,
  perEnvironmentCredentialKeys,
} from '@setup/common/secrets.js';
import type { SetupConfig } from '@setup/common/types.js';
import { buildGuideSteps } from '@setup/infra/guide.js';
import { buildConfig } from '@setup/infra/init-wizard.js';
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

describe('per-environment credentials (.setup/.setup-credentials KEY__<environment>)', () => {
  const config = (stripe: boolean, google: boolean): SetupConfig => {
    const base = buildConfig('acme-org', 'acme-be', 'Acme Backend', ['development', 'production']);
    return {
      ...base,
      providers: {
        ...base.providers,
        stripe: { ...base.providers.stripe, enabled: stripe },
        oauth: { ...base.providers.oauth, google: { enabled: google } },
      },
    };
  };

  it('templates each enabled guide field once per environment, and nothing when disabled', () => {
    expect(perEnvironmentCredentialKeys(config(false, false))).toEqual([]);
    const keys = perEnvironmentCredentialKeys(config(true, true));
    expect(keys).toContain('STRIPE_SECRET_KEY__production');
    expect(keys).toContain('OAUTH_GOOGLE_CLIENT_SECRET__development');
    expect(buildEnvSetupTemplateContent(config(true, false))).toContain(
      'STRIPE_WEBHOOK_SECRET__development=',
    );
  });

  it('only templates keys the guide presets actually collect', () => {
    const collected = new Set(
      PRESETS.flatMap((preset) =>
        preset.kind === 'guide' ? preset.guide.fields.map((field) => field.key) : [],
      ),
    );
    for (const key of perEnvironmentCredentialKeys(config(true, true))) {
      expect(collected).toContain(key.replace(/__[a-z0-9_-]+$/, ''));
    }
  });
});

describe('credentials guide (asks once for missing .setup-credentials values)', () => {
  it('shows a link for every prompt', () => {
    const base = buildConfig('acme-org', 'acme-be', 'Acme Backend', ['development', 'production']);
    const config: SetupConfig = {
      ...base,
      product: { name: 'acme', domain: 'acme.test' },
      providers: {
        ...base.providers,
        stripe: { ...base.providers.stripe, enabled: true },
        oauth: { ...base.providers.oauth, google: { enabled: true } },
      },
    };
    for (const step of buildGuideSteps(config)) {
      for (const environmentName of step.scope === 'per-environment'
        ? ['development', 'production']
        : [undefined]) {
        for (const prompt of step.prompts) {
          const url = step.url?.(environmentName) ?? credentialUrl(prompt.key);
          expect(url, `${step.providerName} ${prompt.key}`).toMatch(/^https:\/\//);
        }
      }
    }
  });
});
