/**
 * Guided-manual provider for services with no API (dashboard/browser only).
 * Prints step-by-step instructions, then pauses and asks the user to paste each
 * key — which it writes to the right .env location automatically.
 *
 * config = {
 *   title?, steps?: string[],
 *   prompts: { ENV_VAR: { label?, secret?, optional? } }
 * }
 */
import type { Provider } from '../types.js';

interface ManualPromptSpec {
  label?: string;
  secret?: boolean;
  optional?: boolean;
}

interface ManualConfig {
  title?: string;
  steps?: string[];
  prompts?: Record<string, ManualPromptSpec>;
}

export const manualProvider: Provider = {
  name: 'manual',

  describe(config) {
    const c = config as ManualConfig;
    return c.title ?? 'Manual step (browser/dashboard)';
  },

  outputKeys(config) {
    const c = config as ManualConfig;
    return Object.keys(c.prompts ?? {});
  },

  async provision(ctx) {
    const c = ctx.config as ManualConfig;
    ctx.log('');
    ctx.log(`    ${c.title ?? 'Manual step'}`);
    if (c.steps?.length) {
      ctx.log('    Follow these steps:');
      c.steps.forEach((s, i) => {
        ctx.log(`      ${i + 1}. ${s}`);
      });
    }
    ctx.log('');

    const outputs: Record<string, string> = {};
    for (const [envVar, spec] of Object.entries(c.prompts ?? {})) {
      const label = spec.label ?? envVar;

      if (ctx.existing[envVar] && !ctx.force) {
        const keep = await ctx.prompt.confirm(
          `    ${envVar} is already set — keep existing?`,
          true,
        );
        if (keep) continue;
      }

      let val = '';
      while (!val) {
        val = await ctx.prompt.ask(`    Paste ${label}`, { secret: spec.secret === true });
        if (val) break;
        if (spec.optional) break;
        if (ctx.prompt.ended) {
          throw new Error(`Required value "${envVar}" was not provided (input ended)`);
        }
        ctx.log('    (required — please paste a value)');
      }
      if (val) outputs[envVar] = val;
    }

    return { outputs };
  },
};
