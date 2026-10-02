/**
 * Sync committed branch rulesets in `.github/rulesets/*.json` to GitHub via `gh`.
 *
 * The committed JSON files are the source of truth. This script is idempotent:
 *   - If a ruleset with the same `name` does not exist on the repo, it is POSTed.
 *   - If one with the same `name` already exists, it is PUT (full replace).
 *
 * Modes:
 *   - default      : create-or-update each committed ruleset on the remote.
 *   - --check      : compare local files vs remote, report drift, exit non-zero on drift.
 *   - --dry-run    : show what would be created or updated without calling write APIs.
 *
 * Plan requirement (private repos): repository rulesets require GitHub Pro / Team /
 * Enterprise on private repos. On the free personal plan the API returns 403 with
 * "Upgrade to GitHub Pro or make this repository public to enable this feature."
 * The script surfaces that message verbatim and exits non-zero.
 *
 * Targets:
 *   - default      : the backend repo (`providers.github.repository`) from its `.github/rulesets`.
 *   - --self       : this repo (clinozy-infra) from its own `.github/rulesets` — `main` is
 *                    protected the same way as the apps' (squash-only, CI must pass).
 *
 * Usage:
 *   pnpm github:rulesets:self [--check | --dry-run]   this repo
 *   pnpm github:rulesets:self:check                   this repo, read-only drift check
 *   tsx src/github/rulesets.ts [--check | --dry-run]  the backend repo (prefer its own github:sync)
 *
 * Importable surface (consumed by init-branches.ts):
 *   - getRepositoryIdentifier()
 *   - loadLocalRulesets()
 *   - syncRulesets({ repository, locals, mode })
 *   - extractTargetBranchesFromRulesets()
 *   - explainPlanBlocker()
 */

import { targetPath, toolPath } from '@setup/common/paths.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGhAuthPreflight } from './auth-preflight.js';
import { ghTry, resolveRepository, toolRepository } from './gh.js';

/** The backend's `.github/rulesets` — resolved on use, so importing never needs the repo. */
const rulesetsDirectory = (): string => targetPath('.github', 'rulesets');

export interface LocalRuleset {
  readonly fileName: string;
  readonly filePath: string;
  readonly payload: Record<string, unknown>;
  readonly name: string;
}

interface RemoteRulesetSummary {
  readonly id: number;
  readonly name: string;
  readonly target: string;
  readonly enforcement: string;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** Re-exported for init.ts; delegates to the shared, injection-safe resolver. */
export function getRepositoryIdentifier(): string {
  return resolveRepository();
}

export function runGhJson<T>(
  args: readonly string[],
  options: { readonly stdin?: string } = {},
): T {
  // No shell — args (including interpolated repo paths) are passed literally to `gh`.
  const result = ghTry([...args], {
    timeoutMs: 30_000,
    ...(options.stdin !== undefined ? { input: options.stdin } : {}),
  });
  if (result.status !== 0) {
    const combined = `${result.stderr}\n${result.stdout}`.trim();
    const statusMatch = combined.match(/HTTP\s+(\d{3})/i);
    const status = statusMatch?.[1] ? Number.parseInt(statusMatch[1], 10) : null;
    throw new GitHubApiError(status, combined || 'gh command failed');
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new GitHubApiError(null, `gh returned invalid JSON: gh ${args.join(' ')}`);
  }
}

export function loadLocalRulesets(directory: string = rulesetsDirectory()): LocalRuleset[] {
  const entries = readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right));

  if (entries.length === 0) {
    throw new Error(`No ruleset files found in ${directory}.`);
  }

  return entries.map((fileName) => {
    const filePath = join(directory, fileName);
    const payload = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) {
      throw new Error(`${fileName}: missing required string field "name".`);
    }
    return { fileName, filePath, payload, name };
  });
}

/**
 * Extract target branch short-names from `conditions.ref_name.include` entries
 * of the form `refs/heads/<branch>`. Wildcards (`refs/heads/*`, `~ALL`) are
 * skipped — only literal branch refs are returned.
 */
export function extractTargetBranchesFromRulesets(locals: readonly LocalRuleset[]): string[] {
  const branches = new Set<string>();
  for (const local of locals) {
    const conditions = local.payload.conditions as { ref_name?: { include?: unknown } } | undefined;
    const include = conditions?.ref_name?.include;
    if (!Array.isArray(include)) {
      continue;
    }
    for (const entry of include) {
      if (typeof entry !== 'string') continue;
      if (!entry.startsWith('refs/heads/')) continue;
      const branch = entry.slice('refs/heads/'.length);
      if (!branch || branch.includes('*')) continue;
      branches.add(branch);
    }
  }
  return [...branches].sort();
}

function listRemoteRulesets(repository: string): RemoteRulesetSummary[] {
  return runGhJson<RemoteRulesetSummary[]>(['api', `repos/${repository}/rulesets`, '--paginate']);
}

function createRemoteRuleset(repository: string, local: LocalRuleset): RemoteRulesetSummary {
  return runGhJson<RemoteRulesetSummary>(
    [
      'api',
      '--method',
      'POST',
      '-H',
      'Accept: application/vnd.github+json',
      `repos/${repository}/rulesets`,
      '--input',
      '-',
    ],
    { stdin: JSON.stringify(local.payload) },
  );
}

function updateRemoteRuleset(
  repository: string,
  rulesetId: number,
  local: LocalRuleset,
): RemoteRulesetSummary {
  return runGhJson<RemoteRulesetSummary>(
    [
      'api',
      '--method',
      'PUT',
      '-H',
      'Accept: application/vnd.github+json',
      `repos/${repository}/rulesets/${rulesetId}`,
      '--input',
      '-',
    ],
    { stdin: JSON.stringify(local.payload) },
  );
}

export type SyncMode = 'sync' | 'check' | 'dry-run';

export interface SyncRulesetsResult {
  readonly failures: number;
  readonly drift: number;
  readonly listError?: GitHubApiError;
}

export function explainPlanBlocker(message: string): string {
  const upgradeHint = /Upgrade to GitHub Pro/i.test(message);
  if (!upgradeHint) {
    return message;
  }
  return [
    message,
    '',
    'Hint: repository rulesets require GitHub Pro / Team / Enterprise on private repos.',
    'Either upgrade the account/org plan, or make the repository public.',
  ].join('\n');
}

/**
 * Core orchestration: list remote rulesets, then for each local file POST (new)
 * or PUT (existing) per mode. Prints per-file status. Returns counters; the
 * caller decides exit code.
 */
export function syncRulesets(args: {
  readonly repository: string;
  readonly locals: readonly LocalRuleset[];
  readonly mode: SyncMode;
}): SyncRulesetsResult {
  const { repository, locals, mode } = args;

  let remote: RemoteRulesetSummary[];
  try {
    remote = listRemoteRulesets(repository);
  } catch (listError) {
    const apiError =
      listError instanceof GitHubApiError ? listError : new GitHubApiError(null, String(listError));
    console.error(`Failed to list rulesets on ${repository}:`);
    console.error(explainPlanBlocker(apiError.message));
    return { failures: 1, drift: 0, listError: apiError };
  }

  const remoteByName = new Map<string, RemoteRulesetSummary>();
  for (const entry of remote) {
    remoteByName.set(entry.name, entry);
  }

  let drift = 0;
  let failures = 0;

  for (const file of locals) {
    const existing = remoteByName.get(file.name);
    const label = `${file.fileName} (${file.name})`;

    if (mode === 'check') {
      if (!existing) {
        console.error(`  ${label}: missing on remote`);
        drift += 1;
      } else {
        console.log(`  ${label}: present on remote (id ${existing.id})`);
      }
      continue;
    }

    if (mode === 'dry-run') {
      console.log(`  ${label}: would ${existing ? `PATCH id ${existing.id}` : 'POST (create)'}`);
      continue;
    }

    try {
      if (existing) {
        const updated = updateRemoteRuleset(repository, existing.id, file);
        console.log(`  ${label}: updated (id ${updated.id})`);
      } else {
        const created = createRemoteRuleset(repository, file);
        console.log(`  ${label}: created (id ${created.id})`);
      }
    } catch (writeError) {
      failures += 1;
      const apiError =
        writeError instanceof GitHubApiError
          ? writeError
          : new GitHubApiError(null, String(writeError));
      console.error(`  ${label}: FAILED`);
      console.error(explainPlanBlocker(apiError.message));
    }
  }

  return { failures, drift };
}

interface CliOptions {
  readonly mode: SyncMode;
  /** Sync this repo's own `.github/rulesets` to this repo instead of the backend's. */
  readonly self: boolean;
}

function parseArguments(): CliOptions {
  const self = process.argv.includes('--self');
  const argumentsList = process.argv.slice(2).filter((argument) => argument !== '--self');

  if (argumentsList.includes('--help') || argumentsList.includes('-h')) {
    console.log('Usage: tsx src/github/rulesets.ts [--self] [--check | --dry-run]');
    console.log('');
    console.log('  (default)   Create-or-update each .github/rulesets/*.json on the repo');
    console.log("  --self      This repo's own .github/rulesets, applied to this repo");
    console.log('  --check     Report drift between local files and remote rulesets');
    console.log('  --dry-run   Show what would be created or updated without writing');
    process.exit(0);
  }

  if (argumentsList.includes('--check')) {
    return { mode: 'check', self };
  }
  if (argumentsList.includes('--dry-run')) {
    return { mode: 'dry-run', self };
  }
  if (argumentsList.length === 0) {
    return { mode: 'sync', self };
  }

  throw new Error(`Unknown argument(s): ${argumentsList.join(' ')}. Use --help for options.`);
}

export async function main(): Promise<void> {
  const { mode, self } = parseArguments();
  const repository = self ? toolRepository() : getRepositoryIdentifier();
  const sourceDirectory = self ? toolPath('.github', 'rulesets') : rulesetsDirectory();
  const locals = loadLocalRulesets(sourceDirectory);

  console.log(`Repository:  ${repository}`);
  console.log(`Source dir:  ${sourceDirectory}`);
  console.log(`Local files: ${locals.map((file) => file.fileName).join(', ')}`);
  console.log(`Mode:        ${mode}`);
  console.log('');

  if (process.env.GITHUB_SYNC_PARENT !== '1') {
    await runGhAuthPreflight({
      repository,
      purpose: 'Sync branch rulesets to the remote repository',
      destructive: mode === 'sync',
    });
  }

  const result = syncRulesets({ repository, locals, mode });

  console.log('');

  if (mode === 'check') {
    if (result.drift === 0 && !result.listError) {
      console.log('Rulesets in sync: every local file is present on remote.');
      process.exit(0);
    }
    if (result.listError) {
      process.exit(1);
    }
    console.error(`Drift detected: ${result.drift} local ruleset(s) missing on remote.`);
    console.error(
      `Run \`${self ? 'pnpm github:rulesets:self' : 'tsx src/github/rulesets.ts'}\` to apply them.`,
    );
    process.exit(1);
  }

  if (mode === 'dry-run') {
    if (result.listError) {
      process.exit(1);
    }
    console.log('Dry run complete. No changes pushed.');
    process.exit(0);
  }

  if (result.failures > 0) {
    console.error(`Sync finished with ${result.failures} failure(s).`);
    process.exit(1);
  }

  console.log('Sync complete.');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
