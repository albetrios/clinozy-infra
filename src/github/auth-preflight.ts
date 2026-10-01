/**
 * Verify the active `gh` CLI account before running a destructive GitHub
 * operation. Shows the active user and the resolved repository, then prompts
 * the operator to confirm, abort, or switch users.
 *
 * Behaviour:
 *   - Interactive TTY → prompt: [Y]es / [n]o / [s]witch user.
 *   - Non-TTY or CI=true → skip the prompt, print active user + repository.
 *   - Missing / failed gh auth → exit non-zero with a hint to run `gh auth login`.
 *
 * Importable from any GitHub-touching script (github/init.ts, github/sync.ts, etc.).
 */

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

export interface PreflightOptions {
  readonly repository: string;
  readonly purpose: string;
  readonly destructive?: boolean;
  readonly interactive?: boolean;
}

interface ActiveAccount {
  readonly login: string;
  readonly host: string;
}

function ghAuthStatus(): string {
  const result = spawnSync('gh', ['auth', 'status'], { encoding: 'utf-8' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    throw new Error(
      `gh auth status failed:\n${output || `exit code ${result.status ?? 'unknown'}`}\n\nRun \`gh auth login\` first.`,
    );
  }
  return output;
}

/**
 * Parse `gh auth status` output to find the currently active account.
 * Supports gh ≥ 2.40 multi-account output where one account is marked as
 * `Active account: true`. Falls back to the first `Logged in to` line for
 * older or single-account installs.
 */
function activeAccountFromStatus(statusOutput: string): ActiveAccount | null {
  const lines = statusOutput.split('\n');
  let currentHost: string | null = null;
  let currentLogin: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (/^(github\.com|[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.test(line) && !line.includes(' ')) {
      currentHost = line;
      currentLogin = null;
    }

    const loginMatch = line.match(/Logged in to \S+ account (\S+)/);
    if (loginMatch?.[1]) {
      currentLogin = loginMatch[1];
    }

    if (/^- Active account:\s*true/i.test(line) && currentLogin && currentHost) {
      return { login: currentLogin, host: currentHost };
    }
  }

  const fallback = statusOutput.match(/Logged in to (\S+) account (\S+)/);
  if (fallback?.[1] && fallback[2]) {
    return { login: fallback[2], host: fallback[1] };
  }
  return null;
}

function isInteractiveShell(): boolean {
  if (process.env.CI === 'true' || process.env.CI === '1') return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function askChoice(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(question);
    return answer.trim().toLowerCase();
  } finally {
    readline.close();
  }
}

function runSwitchUser(): boolean {
  const switchResult = spawnSync('gh', ['auth', 'switch'], { stdio: 'inherit' });
  if (switchResult.status === 0) return true;

  console.log(
    '  `gh auth switch` is unavailable or has no other accounts — falling back to `gh auth login`.',
  );
  const loginResult = spawnSync('gh', ['auth', 'login'], { stdio: 'inherit' });
  return loginResult.status === 0;
}

export async function runGhAuthPreflight(options: PreflightOptions): Promise<void> {
  let active = activeAccountFromStatus(ghAuthStatus());

  console.log('GitHub authentication preflight');
  console.log('-------------------------------');
  console.log(`  Active user: ${active ? `${active.login} on ${active.host}` : '(unparsed)'}`);
  console.log(`  Repository:  ${options.repository}`);
  console.log(`  Purpose:     ${options.purpose}`);
  if (options.destructive) {
    console.log('  Note:        This run will modify GitHub state.');
  }
  console.log('');

  const interactive = options.interactive ?? isInteractiveShell();
  if (!interactive) {
    console.log('  (non-interactive shell — continuing as the active user)');
    console.log('');
    return;
  }

  while (true) {
    const answer = await askChoice('Continue as this user? [Y/n/s=switch user]: ');

    if (answer === '' || answer === 'y' || answer === 'yes') {
      console.log('');
      return;
    }

    if (answer === 'n' || answer === 'no') {
      console.log('Aborted by operator.');
      process.exit(130);
    }

    if (answer === 's' || answer === 'switch') {
      const switched = runSwitchUser();
      if (!switched) {
        console.error('gh authentication did not complete; aborting.');
        process.exit(1);
      }
      active = activeAccountFromStatus(ghAuthStatus());
      console.log('');
      console.log(
        `  Active user is now: ${active ? `${active.login} on ${active.host}` : '(unparsed)'}`,
      );
      console.log('');
      continue;
    }

    console.log('  Please answer Y (continue), n (abort), or s (switch user).');
  }
}
