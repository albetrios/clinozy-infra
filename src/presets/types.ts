/**
 * The clinozy-infra preset model.
 *
 * A preset is the DATA describing a service; `presetToProvider()` turns it into the
 * uniform {@link InfraProvider} the orchestrator already drives. Unlike envforge's
 * outputs-only presets, a clinozy-infra preset must be able to carry the lifecycle
 * behavior the keep-list forbids regressing (settings-review, remote inspection,
 * delete guides, env-var contribution) — so the model is richer than envforge's.
 *
 * Two kinds are supported so far (more added as heavier providers are converted):
 *  - `validate`: probes a credential, creates nothing (Resend). Reuses the existing
 *    `createValidationProvider` machinery.
 *  - `guide`: prints a dashboard walkthrough and collects pasted values per
 *    environment (Stripe, Google OAuth). Reuses the existing interactive collector
 *    (`collectEnvCredentialsForContext`) so the paste/mask/skip UX is unchanged.
 */
import type {
  EnvironmentVariables,
  InfraProvider,
  InfraProviderContext,
  InfraProviderDeleteInstruction,
  InfraProviderDescription,
  InfraProviderPreview,
  ProviderResult,
} from '@setup/common/types.js';
import { collectEnvCredentialsForContext } from '@setup/envs/collect-env-credentials-for-context.js';
import {
  assertCredentialCollectionNotAborted,
  type EnvCredentialField,
  formatEnvCredentialCollectionSummary,
} from '@setup/envs/env-file-setup.util.js';
import { createValidationProvider } from '@setup/infra/providers/create-validation-provider.js';

/** A declared env-var output of a preset (consumed by docs-sync, doctor, .env.example generation). */
export interface PresetOutput {
  /** Env-var key, e.g. `RESEND_API_KEY`. */
  key: string;
  /** Which target repo the key is written to (default: backend). */
  target?: 'backend' | 'frontend';
  /** One-line description for docs/example comments. */
  description?: string;
}

/**
 * Setup-guide metadata — consumed by `setup:infra:guide` to generate the human-facing
 * UI from the catalog (single source of truth; never drifts). The agent/CLI orchestrates
 * on the backend; the human uses the generated guide to place keys.
 */
export interface GuideMeta {
  /** `.setup/.setup-credentials` vars this service needs (account-wide keys). */
  credentials?: string[];
  /** Where to generate the key / token. */
  dashboard?: { url: string; label: string };
  /** True when values are pasted per-environment into `.env.<env>` (guide services). */
  perEnv?: boolean;
  /** Ordered, one-by-one walkthrough shown behind the "i" button in the setup guide. */
  steps?: string[];
}

interface PresetBase extends GuideMeta {
  /** Stable kebab-case key (matches the config key + provider key). */
  key: string;
  /** Human-readable name for logs/tables. */
  name: string;
  isEnabled(context: InfraProviderContext): boolean;
  disabledReason(context: InfraProviderContext): string;
  /** Browser-guided preview metadata (shown when enabled; adapters null it when disabled). */
  preview: InfraProviderPreview;
  /** Short settings-review line (rendered under the 'extra' bucket). */
  settingsDetail: string;
  /** Org / project / environment names for `setup:infra:plan` columns. */
  describe?(context: InfraProviderContext): InfraProviderDescription;
  /** Declared env-var outputs (for docs/doctor/example). */
  outputs?: PresetOutput[];
  /** Optional `.env.<environment>` slice this preset contributes. */
  toEnvironmentVariables?(
    context: InfraProviderContext,
    environmentName: string,
  ): Partial<EnvironmentVariables>;
  /** Manual-delete guide entries. */
  deleteInstructions?(context: InfraProviderContext): InfraProviderDeleteInstruction[];
}

/** Validate-only preset: probes a credential, creates nothing (Resend). */
export interface ValidatePreset extends PresetBase {
  kind: 'validate';
  /** Bullets shown before the step runs. */
  instructions: string[];
  /** Provider-specific validation (also run by `--check`). */
  validate(context: InfraProviderContext): Promise<ProviderResult>;
}

/** Guide preset: prints a dashboard walkthrough, collects pasted values per env. */
export interface GuidePreset extends PresetBase {
  kind: 'guide';
  /** Bullets shown before the step runs (static, or derived from config). */
  instructions: string[] | ((context: InfraProviderContext) => string[]);
  guide: {
    /** Fields the interactive collector prompts for and writes to `.env.<environment>`. */
    fields: EnvCredentialField[];
    /** `per-environment` (default) prompts for each env; `account` prompts once. */
    scope?: 'per-environment' | 'account';
    /** Summary line prefix on success. */
    summaryLine: string;
    /** `inspectRemote` message when enabled (there is no remote resource to inspect). */
    guideError: string;
  };
}

/**
 * Managed preset: wraps a retained provider implementation (the "client lib" — the
 * API-orchestrating providers: Neon, Railway, AWS, Sentry, …) and adds declarative
 * outputs metadata for docs/doctor/example. The heavy provisioning + lifecycle code
 * (inspectRemote/check/deleteInstructions) stays in the retained `provider`; the
 * preset is the thin catalog entry. Per-provider internal thinning (splitting API
 * calls from wiring) can follow later, ideally with integration testing.
 */
export interface ManagedPreset extends GuideMeta {
  kind: 'managed';
  key: string;
  name: string;
  /** Retained implementation (API client + full lifecycle hooks). */
  provider: InfraProvider;
  /** Declared env-var outputs (for docs/doctor/example). */
  outputs?: PresetOutput[];
}

export type Preset = ValidatePreset | GuidePreset | ManagedPreset;

/** Turn a preset into the uniform InfraProvider the orchestrator drives. */
export function presetToProvider(preset: Preset): InfraProvider {
  switch (preset.kind) {
    case 'validate':
      return validateToProvider(preset);
    case 'guide':
      return guideToProvider(preset);
    case 'managed':
      return preset.provider;
  }
}

function validateToProvider(preset: ValidatePreset): InfraProvider {
  // createValidationProvider wraps this with isEnabled → object-or-null itself.
  return createValidationProvider({
    key: preset.key,
    name: preset.name,
    isEnabled: preset.isEnabled,
    disabledReason: preset.disabledReason,
    preview: preset.preview,
    settingsDetail: preset.settingsDetail,
    instructions: preset.instructions,
    ...(preset.describe ? { describe: preset.describe } : {}),
    ...(preset.toEnvironmentVariables
      ? { toEnvironmentVariables: preset.toEnvironmentVariables }
      : {}),
    validate: preset.validate,
  });
}

function guideToProvider(preset: GuidePreset): InfraProvider {
  const resolveInstructions = (context: InfraProviderContext): string[] =>
    typeof preset.instructions === 'function' ? preset.instructions(context) : preset.instructions;

  return {
    key: preset.key,
    name: preset.name,
    isEnabled: preset.isEnabled,
    disabledReason: preset.disabledReason,
    preview: (context) => (preset.isEnabled(context) ? preset.preview : null),
    settingsReview: (context) =>
      preset.isEnabled(context)
        ? [{ bucket: 'extra', provider: preset.name, detail: preset.settingsDetail }]
        : [],
    ...(preset.describe ? { describe: preset.describe } : {}),
    ...(preset.toEnvironmentVariables
      ? { toEnvironmentVariables: preset.toEnvironmentVariables }
      : {}),
    // Guide providers have no remote resource — report that (or the disabled reason).
    inspectRemote: async (context) => ({
      present: false,
      fields: [],
      error: preset.isEnabled(context) ? preset.guide.guideError : preset.disabledReason(context),
    }),
    buildStep: (context) => ({
      name: preset.name,
      enabled: preset.isEnabled(context),
      enabledReason: preset.disabledReason(context),
      instructions: resolveInstructions(context),
      execute: async () => {
        const result = await collectEnvCredentialsForContext(context, {
          providerName: preset.name,
          scope: preset.guide.scope ?? 'per-environment',
          fields: preset.guide.fields,
        });
        assertCredentialCollectionNotAborted(result);
        return {
          success: true,
          message: formatEnvCredentialCollectionSummary(preset.guide.summaryLine, result),
        };
      },
    }),
    ...(preset.deleteInstructions ? { deleteInstructions: preset.deleteInstructions } : {}),
  };
}
