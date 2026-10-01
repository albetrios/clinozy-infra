/**
 * Core types for the generic provisioning engine (vendored from envforge).
 *
 * The engine is data-driven: a "resource" names a generic {@link Provider}
 * ("httpApi" | "manual" | "generate" | "static" | "mock" | custom) plus a config
 * object. Presets (see `src/presets/`) are just functions that emit these
 * {@link ResourceDef}s — so a new service is preset *data*, not provider *code*.
 */
import type { Prompter } from './prompt.js';

export type EnvName = string;

/**
 * Passed to a resource's config function so it can read values already
 * provisioned earlier in the same run (e.g. an auth token → an API call).
 */
export interface ConfigContext {
  env: EnvName;
  project: string;
  /** Value of an env var already known this run (prior resources or the .env file). */
  get(key: string): string | undefined;
}

/** Context handed to a provider when it provisions one resource for one environment. */
export interface ProvisionContext {
  project: string;
  env: EnvName;
  resource: string;
  /** The resolved (per-env) config object for this resource. */
  config: unknown;
  /** Interactive prompter (for guided-manual providers). */
  prompt: Prompter;
  /** Structured logger line writer. */
  log: (msg: string) => void;
  /** Keys already present in the target .env file (so providers can offer to keep them). */
  existing: Record<string, string>;
  /** True when the user passed --force. */
  force: boolean;
}

export interface ProvisionResult {
  /** Map of ENV_VAR -> value to write into the .env file. */
  outputs: Record<string, string>;
  /**
   * Which output keys are worth vaulting in KeyStash. If omitted, the engine
   * vaults everything except `static`/`mock` constants. Set [] to opt a
   * provider's outputs out of the vault entirely. (Consumed in Task 6.)
   */
  vault?: string[];
  /** Anything the provider wants persisted in state (ids, urls, etc.). */
  data?: unknown;
}

export interface Provider {
  name: string;
  /** One-line summary shown by `plan`. */
  describe?(config: unknown, env: EnvName): string;
  /** Which env-var names this resource is expected to produce (used by `plan` and skip-logic). */
  outputKeys?(config: unknown): string[];
  provision(ctx: ProvisionContext): Promise<ProvisionResult>;
}

/** A plain config object for a resource. */
export type ResourceConfigValue = Record<string, unknown>;

/**
 * A config function of (env, ctx) — `ctx.get()` reads values already provisioned
 * this run, enabling chains like "auth token → API call".
 */
export type ResourceConfigFn = (env: EnvName, ctx: ConfigContext) => ResourceConfigValue;

export interface ResourceDef {
  /** Unique name within the project. */
  name: string;
  /** Registered provider: "httpApi" | "manual" | "generate" | "static" | "mock" | <custom>. */
  provider: string;
  /** Static config, or a function of (env, ctx) for chaining. */
  config: ResourceConfigValue | ResourceConfigFn;
  /** Restrict this resource to specific environments (default: all). */
  envs?: EnvName[];
  /**
   * Route this resource's keys to a specific file instead of the project's
   * default envFile(env). Useful for frontend/backend splits
   * (e.g. () => ".env.backend"). Relative to {@link ProvisionOptions.projectDir}.
   */
  file?: (env: EnvName) => string;
}

export interface InfraConfig {
  /** Project name (for logs/state). */
  project: string;
  /** Environments this project has, e.g. ["development", "production"]. */
  environments: EnvName[];
  /** Maps an environment to its target env file path (relative to projectDir). */
  envFile: (env: EnvName) => string;
  /** Resources to provision. Presets may return arrays, so nesting is allowed and flattened. */
  resources: Array<ResourceDef | ResourceDef[]>;
  /**
   * Also hand every provisioned secret to KeyStash (macOS Keychain vault). Off by
   * default; wired in Task 6.
   */
  keystash?: boolean;
}

/** Identity helper that gives full TypeScript autocomplete in a project's infra.config.ts. */
export function defineConfig(c: InfraConfig): InfraConfig {
  return c;
}
