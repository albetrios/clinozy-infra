/**
 * Infra provider registry.
 *
 * The ordered provider list now lives in `infra.config.ts` at the repo root (the
 * RESOURCE composition layer). This module just resolves that config into the
 * `InfraProvider[]` the orchestrator iterates — every provider (preset-backed or
 * bespoke) exposes the same interface, so each runs with the same interaction flow
 * (explain → execute → verify → recover) and the same hooks for preview,
 * settings-review, existence-check, health-check, and manual deletion instructions.
 *
 * To add/remove a service: edit `infra.config.ts` — add a preset (preferred; see
 * `src/presets/`) or a bespoke provider. No change here is needed.
 */
import type { InfraProvider } from '@setup/common/types.js';
import infraConfig from '../../../infra.config.js';

/**
 * The resolved, ordered provider list (from `infra.config.ts`). Resolved lazily on
 * first call — never during module-init — so it is safe against the provider ↔
 * registry import cycle. Call it from runtime code, not at module top-level.
 */
export function getInfraProviders(): readonly InfraProvider[] {
  return infraConfig.providers;
}

/** Whether KeyStash mirroring is enabled in `infra.config.ts` (off by default). */
export function keystashEnabled(): boolean {
  return infraConfig.keystash;
}
