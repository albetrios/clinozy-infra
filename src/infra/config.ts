/**
 * Typed infra config (`defineInfraConfig`) — the RESOURCE composition layer.
 *
 * The split, documented once here:
 *  - `setup.config.json`  → project IDENTITY (org/name/artifacts, environments, app
 *    runtime config). Consumed by codegen and every provider for naming.
 *  - `infra.config.ts`    → the RESOURCE LIST (which services to provision, in order)
 *    plus the per-target env-file mapping. This is the file you edit to add/remove a
 *    service — deleting a line here removes it from `plan`/`up` with no engine change.
 *
 * A resource entry is either a converted {@link Preset} (normalized to an
 * `InfraProvider` via `presetToProvider`) or — during the incremental migration — a
 * still-bespoke `InfraProvider`. Once every service is a preset the list is all presets.
 */
import type { InfraProvider } from '@setup/common/types.js';
import { type Preset, presetToProvider } from '@setup/presets/index.js';

/** Maps an environment name to its target env-file path (relative to the repo root). */
export type EnvFileMapper = (environmentName: string) => string;

/** A resource in `infra.config.ts`: a converted preset, or a transitional bespoke provider. */
export type ResourceEntry = InfraProvider | Preset;

export interface InfraConfigInput {
  /**
   * Per-target env-file path mapping. Identity stays in `setup.config.json`; this
   * file owns resources + where their keys are written.
   */
  envFiles: { backend: EnvFileMapper; frontend: EnvFileMapper };
  /**
   * Ordered resource list — presets and/or bespoke providers (order matters). A
   * THUNK, not a plain array: the providers/presets it references participate in an
   * import cycle (a provider → export-env → build-env-vars → the registry → back
   * here), so the list must be built lazily at first use, not at module-init, or the
   * referenced bindings can still be undefined.
   */
  resources: () => ResourceEntry[];
  /** Mirror provisioned secrets into KeyStash (macOS). Off by default. */
  keystash?: boolean;
}

export interface ResolvedInfraConfig {
  envFiles: { backend: EnvFileMapper; frontend: EnvFileMapper };
  /** The resolved, ordered provider list the orchestrator drives (resolved lazily). */
  readonly providers: readonly InfraProvider[];
  /** Mirror provisioned secrets into KeyStash (macOS). Off by default. */
  keystash: boolean;
}

function isPreset(entry: ResourceEntry): entry is Preset {
  return (
    'kind' in entry &&
    (entry.kind === 'validate' || entry.kind === 'guide' || entry.kind === 'managed')
  );
}

/**
 * Normalize a config's resources into the uniform `InfraProvider[]` the orchestrator
 * consumes: presets are turned into providers via {@link presetToProvider}; bespoke
 * providers pass through. Preserves order.
 */
export function defineInfraConfig(input: InfraConfigInput): ResolvedInfraConfig {
  let cached: readonly InfraProvider[] | undefined;
  return {
    envFiles: input.envFiles,
    keystash: input.keystash ?? false,
    get providers() {
      if (cached === undefined) {
        cached = input
          .resources()
          .map((entry) => (isPreset(entry) ? presetToProvider(entry) : entry));
      }
      return cached;
    },
  };
}
