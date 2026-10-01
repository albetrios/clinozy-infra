/**
 * The generic provisioning loop (vendored from envforge, adapted for clinozy-infra).
 *
 * Given an {@link InfraConfig}, for each environment it walks the resource list,
 * resolves each resource's config (supporting `ctx.get()` chaining — a resource's
 * config function can read env vars provisioned earlier this run), invokes the
 * named provider, and surgically upserts the results into the target `.env` file.
 *
 * clinozy-infra-specific adaptations vs. envforge:
 *  - State is EPHEMERAL (see `state.ts`): the caller owns the {@link State} object
 *    and may pre-hydrate it from remote detection; nothing is written to disk.
 *  - Every provisioned key is recorded in the audit log (`.setup-audit.log`).
 *  - Logging routes through `src/common/logger.ts`.
 *  - KeyStash vaulting is deferred to Task 6 (seam marked below).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditCreate, auditUpdate } from '@setup/common/audit.js';
import * as logger from '@setup/common/logger.js';
import { parseEnv, upsertEnv } from './env-file.js';
import { createPrompter, type Prompter } from './prompt.js';
import { getProvider } from './registry.js';
import { createState, type State } from './state.js';
import type {
  ConfigContext,
  EnvName,
  InfraConfig,
  ResourceConfigFn,
  ResourceDef,
} from './types.js';

/** Providers whose outputs are re-derivable constants — never vaulted (Task 6). */
export const CONSTANT_PROVIDERS = new Set(['static', 'mock']);

/** Audit hooks — injectable so tests can assert without touching the real log. */
export interface EngineAudit {
  create(provider: string, resource: string, detail: string): void;
  update(provider: string, resource: string, detail: string): void;
}

const defaultAudit: EngineAudit = { create: auditCreate, update: auditUpdate };

export interface ProvisionOptions {
  /** Directory the resource `envFile(env)` / `file(env)` paths resolve against. */
  projectDir: string;
  /** Restrict to these environments (default: all in config). */
  envs?: string[];
  /** Restrict to these resource names (default: all). */
  resources?: string[];
  /** Re-provision even when keys already exist. */
  force?: boolean;
  /** Print the plan without writing anything. */
  dryRun?: boolean;
  /** In-memory state; pre-hydrate from remote to drive skip-logic. Default: fresh. */
  state?: State;
  /** Prompter for guided-manual providers. Default: TTY/piped auto-detect. */
  prompter?: Prompter;
  /** Line writer. Default: routed through the shared logger. */
  log?: (msg: string) => void;
  /** Audit hooks. Default: writes to `.setup-audit.log`. */
  audit?: EngineAudit;
}

/** Default log routes engine lines through the shared logger. */
function defaultLog(msg: string): void {
  if (msg.trim() === '') logger.blank();
  else logger.infoRaw(msg);
}

/** Resolve a resource's config, running its function form with the chaining ctx. */
export function resolveResourceConfig(
  res: ResourceDef,
  env: EnvName,
  ctx: ConfigContext,
): Record<string, unknown> {
  const c = res.config;
  return typeof c === 'function' ? (c as ResourceConfigFn)(env, ctx) : c;
}

/** A no-op config context for read-only introspection (status/example/doctor). */
export function introspectCtx(env: EnvName, project: string): ConfigContext {
  return { env, project, get: () => undefined };
}

/**
 * Provision an in-memory {@link InfraConfig}. Returns the mutated state.
 *
 * Task 4 adds `loadConfig()` to read this from `infra.config.ts`; the loop itself
 * is decoupled from disk config so it stays unit-testable.
 */
export async function provisionConfig(config: InfraConfig, opts: ProvisionOptions): Promise<State> {
  const { projectDir } = opts;
  const state = opts.state ?? createState();
  const log = opts.log ?? defaultLog;
  const audit = opts.audit ?? defaultAudit;
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;

  const targetEnvs = opts.envs?.length ? opts.envs : config.environments;
  for (const env of targetEnvs) {
    if (!config.environments.includes(env)) {
      throw new Error(`Unknown environment "${env}". Known: ${config.environments.join(', ')}`);
    }
  }

  const prompter = opts.prompter ?? createPrompter();
  const ownsPrompter = !opts.prompter;

  try {
    const allResources = config.resources.flat();

    for (const env of targetEnvs) {
      log(`\n=== ${config.project} :: ${env} ===`);

      // Cache parsed env files by path so per-resource file overrides work and stay
      // fresh as we write. `known` is the merged view every resource's config can
      // read via ctx.get() — this is what enables chains.
      const fileCache = new Map<string, Record<string, string>>();
      const known: Record<string, string> = {};
      const readEnv = (p: string): Record<string, string> => {
        let parsed = fileCache.get(p);
        if (!parsed) {
          parsed = existsSync(p) ? parseEnv(readFileSync(p, 'utf8')) : {};
          fileCache.set(p, parsed);
          for (const [k, v] of Object.entries(parsed)) if (!(k in known)) known[k] = v;
        }
        return parsed;
      };
      const ctx: ConfigContext = { env, project: config.project, get: (k) => known[k] };

      const resources = allResources.filter(
        (r) =>
          (!opts.resources?.length || opts.resources.includes(r.name)) &&
          (!r.envs || r.envs.includes(env)),
      );

      for (const res of resources) {
        const provider = getProvider(res.provider);
        const rc = resolveResourceConfig(res, env, ctx);
        const keys = provider.outputKeys?.(rc) ?? [];
        const relPath = res.file ? res.file(env) : config.envFile(env);
        const envPath = resolve(projectDir, relPath);
        const existingEnv = readEnv(envPath);

        if (dryRun) {
          const desc = provider.describe?.(rc, env) ?? res.provider;
          log(`  [plan] ${res.name} (${res.provider}): ${desc}`);
          log(`         writes ${keys.join(', ') || '(dynamic)'} → ${relPath}`);
          continue;
        }

        // API/static/generate resources already provisioned & fully present are
        // skipped unless --force. Manual resources decide per-key inside the provider.
        const already = state[env]?.[res.name];
        const allPresent = keys.length > 0 && keys.every((k) => existingEnv[k]);
        if (provider.name !== 'manual' && already && allPresent && !force) {
          log(`  [skip] ${res.name} — already provisioned (use --force to re-run)`);
          continue;
        }

        log(`  [run]  ${res.name} (${res.provider})`);
        const result = await provider.provision({
          project: config.project,
          env,
          resource: res.name,
          config: rc,
          prompt: prompter,
          log,
          existing: existingEnv,
          force,
        });

        const wrote = Object.keys(result.outputs);
        if (wrote.length) {
          const { changed, added } = upsertEnv(envPath, result.outputs);
          Object.assign(existingEnv, result.outputs);
          Object.assign(known, result.outputs); // visible to later resources' config
          for (const k of changed) audit.update(res.provider, res.name, `${k} → ${relPath}`);
          for (const k of added) audit.create(res.provider, res.name, `${k} → ${relPath}`);
          log(`  [ok]   ${[...changed, ...added].join(', ')} → ${relPath}`);
          // NOTE: KeyStash vault handoff is added in Task 6 (uses CONSTANT_PROVIDERS
          // + result.vault to decide which outputs to mirror).
        } else {
          log('  [ok]   no changes');
        }

        const envState = state[env] ?? {};
        state[env] = envState;
        envState[res.name] = {
          provisionedAt: new Date().toISOString(),
          outputs: keys,
          ...(result.data !== undefined ? { data: result.data } : {}),
        };
      }
    }
  } finally {
    if (ownsPrompter) prompter.close();
  }

  log('\nDone.');
  return state;
}
