/**
 * Shared subprocess helpers for the setup-infra module.
 *
 * One place for `spawnSync`/`execSync` so callers don't re-roll stdio/timeout/error
 * handling. Standalone (no `@/` imports). Throws {@link SetupError} on failure unless
 * `allowFailure` is set.
 */
import { spawnSync } from 'node:child_process';
import { SetupError } from './setup-error.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RunCommandOptions {
  /** Arguments passed directly (no shell) — safe from injection. */
  args?: string[];
  /** String piped to the process stdin (e.g. clipboard payloads). */
  input?: string;
  /** Working directory for the child process. */
  cwd?: string;
  /** Environment for the child process (default: this process's). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Return the result instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
}

export interface RunCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run a command with an argument array (no shell). Throws SetupError on failure. */
export function runCommand(command: string, options: RunCommandOptions = {}): RunCommandResult {
  const result = spawnSync(command, options.args ?? [], {
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const status = result.status ?? 1;
  const out = { status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (status !== 0 && !options.allowFailure) {
    throw new SetupError(
      `Command failed: ${command} ${(options.args ?? []).join(' ')} — ${out.stderr.trim() || `exit ${status}`}`,
    );
  }
  return out;
}

/** True when a command is resolvable on PATH (uses an explicit `/bin/sh` to avoid shell+args warnings). */
export function commandExists(command: string): boolean {
  if (process.platform === 'win32') {
    return spawnSync('where', [command], { stdio: 'ignore' }).status === 0;
  }
  return spawnSync('/bin/sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}
