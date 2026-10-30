/**
 * Shared, injection-safe `gh`/`git` CLI helpers for the github/ modules.
 *
 * Every call goes through `runCommand` (spawnSync with an argv array — NO shell), so interpolated
 * repository / environment / branch names can never reach a shell. A path like
 * `repos/owner/repo/environments/${env}` is passed as a SINGLE argument to `gh`, so shell
 * metacharacters (`;`, `$()`, `|`) in it are literal, not executed.
 *
 * Also centralizes backend repository resolution (env → config → target git remote → gh) for
 * environments.ts, rulesets.ts, init.ts, and sync-github-environments.ts.
 */
import { runCommand, type RunCommandResult } from '@setup/common/exec.js';
import { loadConfig } from '@setup/common/config.js';
import { targetRoot, toolRoot } from '@setup/common/paths.js';
import { SetupError } from '@setup/common/setup-error.js';

export interface GhOptions {
  input?: string;
  timeoutMs?: number;
  /** Environment for `gh` — e.g. {@link operatorGhEnv} to act as the operator's own login. */
  env?: NodeJS.ProcessEnv;
}

/**
 * This process's environment without `GITHUB_TOKEN` / `GH_TOKEN`, so `gh` acts as the operator's
 * own `gh auth login` instead of setup's narrowly-scoped token from `.setup/.setup-credentials`.
 */
export function operatorGhEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'GITHUB_TOKEN' && key !== 'GH_TOKEN'),
  );
}

/** Run `gh <args>` (no shell). Returns trimmed stdout; throws SetupError on non-zero exit. */
export function gh(args: string[], options: GhOptions = {}): string {
  return runCommand('gh', { args, ...options }).stdout.trim();
}

/** Run `gh <args>` (no shell) without throwing — returns the full result for status inspection. */
export function ghTry(args: string[], options: GhOptions = {}): RunCommandResult {
  return runCommand('gh', { args, allowFailure: true, ...options });
}

/** Run `gh <args>` and JSON.parse stdout. Throws SetupError on non-zero exit or invalid JSON. */
export function ghJson<T = unknown>(args: string[], options: GhOptions = {}): T {
  const stdout = gh(args, options);
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new SetupError(
      `gh returned invalid JSON for: gh ${args.join(' ')} — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function repositoryFromGitRemote(cwd?: string): string | undefined {
  const result = runCommand('git', {
    args: ['remote', 'get-url', 'origin'],
    allowFailure: true,
    timeoutMs: 5_000,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  if (result.status !== 0) return undefined;
  const remoteUrl = result.stdout.trim();

  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (sshMatch?.[1]) return sshMatch[1];

  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (httpsMatch?.[1]) return httpsMatch[1];

  return undefined;
}

/**
 * Resolve the backend's `owner/repo`: `GITHUB_REPOSITORY` env → `providers.github.repository` →
 * the target checkout's git remote → `gh repo view` in it. Throws when none work.
 */
export function resolveRepository(): string {
  if (process.env.GITHUB_REPOSITORY?.includes('/')) {
    return process.env.GITHUB_REPOSITORY;
  }

  // The backend repository from setup.config.json — the files these scripts sync are read from it
  // (`targetPath('.github', …)`). Never this tool's own checkout, whose git remote is clinozy-infra.
  const configured = (() => {
    try {
      return loadConfig().providers.github.repository;
    } catch {
      return undefined;
    }
  })();
  if (configured?.includes('/')) return configured;

  // No config: ask the backend checkout, never the current directory — these scripts run from
  // this tool's checkout.
  const backendRoot = targetRoot();
  const fromGit = repositoryFromGitRemote(backendRoot);
  if (fromGit) return fromGit;

  const result = runCommand('gh', {
    args: ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    allowFailure: true,
    timeoutMs: 15_000,
    cwd: backendRoot,
  });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  throw new SetupError(
    `Cannot resolve the backend repository: set providers.github.repository in setup.config.json, give ${backendRoot} a github.com origin remote, or authenticate gh.`,
  );
}

/** This tool's own repository (`owner/clinozy-infra`), read from the git remote of its checkout. */
export function toolRepository(): string {
  const fromGit = repositoryFromGitRemote(toolRoot());
  if (fromGit) return fromGit;
  throw new SetupError(
    `Cannot resolve this repository: ${toolRoot()} has no github.com origin remote.`,
  );
}
