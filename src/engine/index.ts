/**
 * Public surface of the generic provisioning engine.
 *
 * This engine is vendored from envforge (see `docs/envforge-convergence.md`,
 * added in Task 8). Presets (Task 3) build on the generic providers exported via
 * the registry; the orchestrator (Task 4) drives {@link provisionConfig}.
 */
export type {
  ConfigContext,
  EnvName,
  InfraConfig,
  Provider,
  ProvisionContext,
  ProvisionResult,
  ResourceConfigFn,
  ResourceConfigValue,
  ResourceDef,
} from './types.js';
export { defineConfig } from './types.js';

export { parseEnv, upsertEnv, upsertEnvContent, type ValueFormatter } from './env-file.js';
export { createState, type ResourceState, type State } from './state.js';
export { createPrompter, type AskOptions, type Prompter } from './prompt.js';
export { getProvider, register, registeredProviders } from './registry.js';
export {
  CONSTANT_PROVIDERS,
  introspectCtx,
  provisionConfig,
  resolveResourceConfig,
  type EngineAudit,
  type ProvisionOptions,
} from './engine.js';

// Re-export the built-in providers so presets/tests can reference them directly.
export { httpApiProvider } from './providers/http-api.js';
export { manualProvider } from './providers/manual.js';
export { generateProvider } from './providers/generate.js';
export { commandProvider } from './providers/command.js';
export { mockProvider, staticProvider } from './providers/constants.js';
