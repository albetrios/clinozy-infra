/**
 * Shared, injection-safe `gh`/`git` CLI helpers for the github/ modules.
 *
 * Every call goes through `runCommand` (spawnSync with an argv array — NO shell), so interpolated
 * repository / environment / branch names can never reach a shell. A path like
 * `repos/owner/repo/environments/${env}` is passed as a SINGLE argument to `gh`, so shell
 * metacharacters (`;`, `$()`, `|`) in it are literal, not executed.
 *
 * Also centralizes repository resolution (env → git remote → gh) that was previously duplicated
 * across environments.ts, rulesets.ts, push-retention-secrets.ts, and sync-github-environments.ts.
 */
import { runCommand, type RunCommandResult } from '@setup/common/exec.js';
import { SetupError } from '@setup/common/setup-error.js';

export interface GhOptions {
  input?: string;
  timeoutMs?: number;
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

function repositoryFromGitRemote(): string | undefined {
  const result = runCommand('git', {
    args: ['remote', 'get-url', 'origin'],
    allowFailure: true,
    timeoutMs: 5_000,
  });
  if (result.status !== 0) return undefined;
  const remoteUrl = result.stdout.trim();

  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (sshMatch?.[1]) return sshMatch[1];

  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (httpsMatch?.[1]) return httpsMatch[1];

  return undefined;
}

/** Resolve `owner/repo`: `GITHUB_REPOSITORY` env → git remote → `gh repo view`. Throws when none work. */
export function resolveRepository(): string {
  if (process.env.GITHUB_REPOSITORY?.includes('/')) {
    return process.env.GITHUB_REPOSITORY;
  }

  const fromGit = repositoryFromGitRemote();
  if (fromGit) return fromGit;

  const result = runCommand('gh', {
    args: ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    allowFailure: true,
    timeoutMs: 15_000,
  });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  throw new SetupError(
    'Cannot resolve repository: set GITHUB_REPOSITORY, use a github.com git remote, or authenticate gh.',
  );
}
