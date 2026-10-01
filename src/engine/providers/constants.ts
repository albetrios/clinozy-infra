/**
 * Constant-emitting providers (envforge's `mock.ts`).
 *
 * - `static` writes known constants / sensible defaults straight into the .env
 *   (e.g. EMAIL_FROM, POSTHOG_HOST, OAUTH_PORT, SENTRY_ORG). No network, no prompt.
 * - `mock` is identical behavior, named for test/demo intent.
 *
 * config = { outputs: { ENV_VAR: "value" | (env) => string | number } }
 */
import type { EnvName, Provider } from '../types.js';

type ConstantValue = string | number | ((env: EnvName) => string | number);

interface ConstantConfig {
  outputs?: Record<string, ConstantValue>;
}

/** Emit config.outputs literally, resolving functions and {env}. */
function literal(env: EnvName, config: ConstantConfig): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.outputs ?? {})) {
    outputs[k] = typeof v === 'function' ? String(v(env)) : String(v).replace(/\{env\}/g, env);
  }
  return outputs;
}

export const staticProvider: Provider = {
  name: 'static',
  describe(config) {
    const c = config as ConstantConfig;
    return `set constants: ${Object.keys(c.outputs ?? {}).join(', ')}`;
  },
  outputKeys(config) {
    const c = config as ConstantConfig;
    return Object.keys(c.outputs ?? {});
  },
  async provision(ctx) {
    return { outputs: literal(ctx.env, ctx.config as ConstantConfig) };
  },
};

export const mockProvider: Provider = {
  name: 'mock',
  describe(config) {
    const c = config as ConstantConfig;
    return `mock generate: ${Object.keys(c.outputs ?? {}).join(', ')}`;
  },
  outputKeys(config) {
    const c = config as ConstantConfig;
    return Object.keys(c.outputs ?? {});
  },
  async provision(ctx) {
    return { outputs: literal(ctx.env, ctx.config as ConstantConfig) };
  },
};
