/**
 * Generic `command` provider: run a command in a target directory and (optionally)
 * capture its stdout into env vars. This is the ONE generic provider the bespoke
 * doc-publishing providers need — Postman (`pnpm docs:all`) and Scalar
 * (`pnpm docs:generate` + `pnpm docs:upload:scalar`) run tooling inside the target
 * repo and parse the output — rather than keeping per-service command code.
 *
 * config = {
 *   command, args?, cwd?, env?, timeoutMs?,
 *   outputs?: { ENV_VAR: { stdout: true } | { match: "<regex, group 1>" } }
 * }
 */
import { execFileSync } from 'node:child_process';
import type { Provider } from '../types.js';

interface CommandOutputSpec {
  /** Capture the whole trimmed stdout. */
  stdout?: boolean;
  /** Capture regex group 1 (or the whole match) from stdout. */
  match?: string;
}

interface CommandConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  outputs?: Record<string, CommandOutputSpec>;
}

export const commandProvider: Provider = {
  name: 'command',

  describe(config) {
    const c = config as CommandConfig;
    return `${c.command} ${(c.args ?? []).join(' ')}`.trim();
  },

  outputKeys(config) {
    const c = config as CommandConfig;
    return Object.keys(c.outputs ?? {});
  },

  async provision(ctx) {
    const c = ctx.config as CommandConfig;
    ctx.log(`    $ ${c.command} ${(c.args ?? []).join(' ')}`.trimEnd());

    let stdout: string;
    try {
      stdout = execFileSync(c.command, c.args ?? [], {
        encoding: 'utf8',
        env: { ...process.env, ...(c.env ?? {}) },
        timeout: c.timeoutMs ?? 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
      });
    } catch (e) {
      throw new Error(`Command "${c.command}" failed: ${e instanceof Error ? e.message : e}`);
    }

    const outputs: Record<string, string> = {};
    for (const [envVar, spec] of Object.entries(c.outputs ?? {})) {
      if (spec.match) {
        const m = stdout.match(new RegExp(spec.match));
        const val = m?.[1] ?? m?.[0];
        if (val === undefined) {
          throw new Error(
            `command output "${envVar}": pattern "${spec.match}" not found in stdout`,
          );
        }
        outputs[envVar] = val.trim();
      } else {
        outputs[envVar] = stdout.trim();
      }
    }

    return { outputs, data: { ran: true } };
  },
};
