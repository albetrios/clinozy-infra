/**
 * `pnpm github:sync` against a single-trunk backend: `main` deploys to every environment
 * (development on merge, production on release), so the deploy workflow takes the environment from
 * its caller and allowlists it — the consistency check compares that allowlist with
 * setup.config.json instead of a branch→environment map. The sync also targets the backend's
 * repository even though it runs from this tool's checkout.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTargetRoot } from '@setup/common/paths.js';
import type { SetupConfig } from '@setup/common/types.js';
import { resolveRepository } from '@setup/github/gh.js';
import { getGithubSyncBranches, validateGithubSyncConsistency } from '@setup/github/sync-config.js';
import { syncEnvironmentToGitHub } from '@setup/github/sync-github-environments.js';
import { buildConfig } from '@setup/infra/init-wizard.js';

// gh.ts reads the backend repository from setup.config.json; each test decides what that returns.
const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock('@setup/common/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@setup/common/config.js')>()),
  loadConfig,
}));

/** Both environments deploy from `main`, as in the backend's setup.config.json. */
const singleTrunk = (): SetupConfig => {
  const config = buildConfig('acme-org', 'acme-be', 'Acme Backend', ['development', 'production']);
  return {
    ...config,
    environments: config.environments.map((environment) => ({
      ...environment,
      deployBranch: 'main',
    })),
  };
};

/** The resolve step of the backend's reusable-railway-deploy.yml, with `cases` as its allowlist. */
const deployWorkflow = (cases: string): string => `jobs:
  resolve-environment:
    steps:
      - id: map
        run: |
          set -euo pipefail
          if [ -n "$GITHUB_ENVIRONMENT_INPUT" ]; then
            environment="$GITHUB_ENVIRONMENT_INPUT"
          elif [ "$EVENT_NAME" = "workflow_dispatch" ] && [ -n "$TARGET_INPUT" ]; then
            environment="$TARGET_INPUT"
          else
            echo "::error::No deploy environment specified." && exit 1
          fi
          case "$environment" in
            ${cases}
            *) echo "::error::Invalid environment: $environment" && exit 1 ;;
          esac
`;

let backendDir = '';

function writeBackendFile(path: string, contents: string): void {
  const filePath = join(backendDir, path);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf-8');
}

/** A backend checkout with the committed GitHub IaC for development + production on `main`. */
function writeBackend(workflow: string): void {
  writeBackendFile('.github/rulesets/main.json', '{}\n');
  writeBackendFile('.github/environments/development.json', '{ "name": "development" }\n');
  writeBackendFile('.github/environments/production.json', '{ "name": "production" }\n');
  writeBackendFile('.github/workflows/reusable-railway-deploy.yml', workflow);
}

beforeEach(() => {
  backendDir = mkdtempSync(join(tmpdir(), 'github-sync-be-'));
  setTargetRoot(backendDir);
  // CI sets this to the repository the job runs in — this tool's own.
  vi.stubEnv('GITHUB_REPOSITORY', '');
  loadConfig.mockReset();
});

afterEach(() => {
  rmSync(backendDir, { recursive: true, force: true });
  setTargetRoot(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('validateGithubSyncConsistency', () => {
  const allowlist =
    'development|production) echo "environment=$environment" >> "$GITHUB_OUTPUT" ;;';

  it('passes when both environments deploy from main and the workflow allowlists both', () => {
    writeBackend(deployWorkflow(allowlist));
    expect(validateGithubSyncConsistency(singleTrunk())).toEqual([]);
  });

  it('flags a configured environment the workflow cannot deploy', () => {
    writeBackend(
      deployWorkflow('development) echo "environment=$environment" >> "$GITHUB_OUTPUT" ;;'),
    );
    expect(validateGithubSyncConsistency(singleTrunk()).map((issue) => issue.detail)).toEqual([
      'Configured environment "production" is not in the deploy allowlist of reusable-railway-deploy.yml.',
    ]);
  });

  it('flags a workflow environment missing from setup.config.json', () => {
    writeBackend(
      deployWorkflow(
        'development|production|staging) echo "environment=$environment" >> "$GITHUB_OUTPUT" ;;',
      ),
    );
    expect(validateGithubSyncConsistency(singleTrunk()).map((issue) => issue.detail)).toEqual([
      'Workflow deploys environment "staging", which is not listed in setup.config.json.',
    ]);
  });

  it('flags a workflow with no environment allowlist (e.g. a branch→environment map)', () => {
    writeBackend(
      deployWorkflow(
        'main) echo "environment=production" >> "$GITHUB_OUTPUT" ;;\n            dev) echo "environment=development" >> "$GITHUB_OUTPUT" ;;',
      ),
    );
    expect(validateGithubSyncConsistency(singleTrunk()).map((issue) => issue.detail)).toEqual([
      'reusable-railway-deploy.yml has no deploy environment allowlist (`<env>|<env>) echo "environment=$environment"`).',
    ]);
  });

  it('flags a deploy branch without a ruleset once, however many environments share it', () => {
    writeBackend(deployWorkflow(allowlist));
    rmSync(join(backendDir, '.github/rulesets/main.json'));
    expect(validateGithubSyncConsistency(singleTrunk()).map((issue) => issue.detail)).toEqual([
      'Configured branch "main" has no .github/rulesets/main.json.',
    ]);
  });

  it('lists the shared deploy branch once for the remote branch + ruleset sync', () => {
    expect(getGithubSyncBranches(singleTrunk())).toEqual(['main']);
  });
});

describe('the GitHub repository github:sync targets', () => {
  /** Make the backend checkout a git repo whose origin is `acme/acme-be`. */
  function initBackendRemote(): void {
    execFileSync('git', ['init', '-q', backendDir]);
    execFileSync('git', [
      '-C',
      backendDir,
      'remote',
      'add',
      'origin',
      'git@github.com:acme/acme-be.git',
    ]);
  }

  it("is the backend's configured repository, named in a dry run", async () => {
    loadConfig.mockReturnValue({ providers: { github: { repository: 'acme/acme-be' } } });
    writeBackendFile('.env.development', 'NODE_ENV=development\nJWT_SECRET=x\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await syncEnvironmentToGitHub({ environment: 'development', dryRun: true });

    expect(log.mock.calls.map(([line]) => String(line))).toContain('Repository:  acme/acme-be');
  });

  it("falls back to the backend checkout's remote, not the current directory's", () => {
    loadConfig.mockImplementation(() => {
      throw new Error('no setup.config.json');
    });
    initBackendRemote();
    // The current directory is this tool's own checkout (clinozy-infra).
    expect(resolveRepository()).toBe('acme/acme-be');
  });
});
