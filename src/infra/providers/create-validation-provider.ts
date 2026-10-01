/**
 * Factory for validate-only providers (no resource is created — they only verify a
 * credential/format per run). Collapses the previously-duplicated resend/stripe/oauth/
 * turnstile boilerplate into one place: each provider supplies a small spec + a
 * `validate(context)` callback; the factory wires the uniform `InfraProvider` shape
 * (isEnabled/preview/settingsReview/buildStep).
 *
 * NAMING (single source of truth = setup.config.json): names come from `config.*` via the
 * provided callbacks — never hardcoded here.
 * SECRETS: never printed; values flow to `.env.<environment>` via build-env-vars.
 */
import type {
  EnvironmentVariables,
  InfraProvider,
  InfraProviderContext,
  InfraProviderDescription,
  ProviderResult,
} from '@setup/common/types.js';

export interface ValidationProviderSpec {
  /** Stable kebab-case key matching the folder/config key. */
  key: string;
  /** Human-readable name for logs/tables. */
  name: string;
  isEnabled: (context: InfraProviderContext) => boolean;
  disabledReason: (context: InfraProviderContext) => string;
  /** Browser-guided preview metadata (token URL + config key). */
  preview: { detail: string; url: string; configKey: string };
  /** Short settings-review line (rendered under the 'extra' bucket). */
  settingsDetail: string;
  /** Bullets shown before the step runs. */
  instructions: string[];
  /** Org / project / environment names for `setup:infra:plan` columns. */
  describe?: (context: InfraProviderContext) => InfraProviderDescription;
  /**
   * Optional `.env.<environment>` slice this provider contributes. Most validate-only
   * providers (Stripe/OAuth/Turnstile) emit nothing — their secrets are user-entered in the
   * env file. Resend is the exception (it emits RESEND_API_KEY / EMAIL_FROM_*).
   */
  toEnvironmentVariables?: (
    context: InfraProviderContext,
    environmentName: string,
  ) => Partial<EnvironmentVariables>;
  /** Provider-specific validation; returns success/message (no throw). */
  validate: (context: InfraProviderContext) => Promise<ProviderResult>;
}

/** Build a complete validate-only `InfraProvider` from a spec. */
export function createValidationProvider(spec: ValidationProviderSpec): InfraProvider {
  const provider: InfraProvider = {
    key: spec.key,
    name: spec.name,
    isEnabled: spec.isEnabled,
    disabledReason: spec.disabledReason,
    preview: (context) => (spec.isEnabled(context) ? spec.preview : null),
    settingsReview: (context) =>
      spec.isEnabled(context)
        ? [{ bucket: 'extra', provider: spec.name, detail: spec.settingsDetail }]
        : [],
    ...(spec.describe ? { describe: spec.describe } : {}),
    ...(spec.toEnvironmentVariables ? { toEnvironmentVariables: spec.toEnvironmentVariables } : {}),
    // Validate-only providers have no remote resource to inspect — they probe a credential.
    // Report that explicitly instead of a fake present/absent. When not enabled, surface the
    // ACTUAL reason via `disabledReason` (e.g. "RESEND_API_KEY missing …") rather than a
    // blanket "disabled in setup.config.json".
    inspectRemote: async (context) => ({
      present: false,
      fields: [],
      error: spec.isEnabled(context)
        ? 'validate-only — no remote resource (credential checked during apply)'
        : spec.disabledReason(context),
    }),
    buildStep: (context: InfraProviderContext) => ({
      name: spec.name,
      enabled: provider.isEnabled(context),
      enabledReason: provider.disabledReason(context),
      instructions: spec.instructions,
      execute: async () => {
        const result = await spec.validate(context);
        if (!result.success) throw new Error(result.message);
        return result;
      },
    }),
  };
  return provider;
}
