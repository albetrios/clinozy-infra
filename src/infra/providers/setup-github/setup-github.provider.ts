/**
 * GitHub provider for `pnpm setup:infra`.
 *
 * Verifies repository access and makes sure both app repos — the backend and the frontend — have a
 * GitHub Environment per configured environment (an existing one is left untouched; a missing one is
 * created empty). Each app's own `pnpm github:sync` then pushes its `.env.<environment>` into it.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*` (+ `providers.github.repository`), environment names from
 * `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only (via build-env-vars), never printed to the
 * console; setup secret files are gitignored and written owner-only. See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import { runCommand } from '@setup/common/exec.js';
import * as logger from '@setup/common/logger.js';
import { frontendRepository } from '@setup/common/config.js';
import { ensureGithubEnvironment, runGithubInit } from '@setup/github/init.js';
import type {
  SetupConfig,
  SetupSecrets,
  SetupState,
  ProviderResult,
  InfraProvider,
  InfraProviderContext,
} from '@setup/common/types.js';

function formatGitHubEnvironmentPlan(config: SetupConfig): string {
  return config.environments
    .map(
      (environment) =>
        `${environment.name} (${environment.label}; branch ${environment.deployBranch}; Railway services: api, worker + redis database)`,
    )
    .join(', ');
}

function ghCommand(args: string[]): string {
  // No shell — args (including the interpolated repository) are passed literally to `gh`.
  const result = runCommand('gh', { args, timeoutMs: 15_000, allowFailure: true });
  if (result.status !== 0) {
    throw new Error(`GitHub CLI failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

/**
 * GitHub repo-level setup is a verify-and-record step. No secrets are pushed here —
 * the Railway provider mints per-environment project tokens, persists them in state,
 * `exportEnvFiles` writes each into the matching `.env.<env>` as `RAILWAY_TOKEN`, and
 * the dedicated GitHub-sync step (`buildGitHubSyncStep` → `syncEnvironmentToGitHub`)
 * reads each `.env.<environment>`, classifies keys as secret-vs-variable via the
 * central `classifyKey` rules, and pushes them per GitHub Environment. So
 * `${{ secrets.RAILWAY_TOKEN }}` in the deploy workflow resolves to the env-scoped
 * token automatically.
 *
 * Pushing env-scoped items here as well would create the same key under both Secrets
 * and Variables in a GitHub Environment.
 */
export async function provision(
  config: SetupConfig,
  _secrets: SetupSecrets,
  _state: SetupState,
  environments: string[],
): Promise<ProviderResult> {
  const repository = config.providers.github.repository;
  const spinner = logger.startSpinner('Verifying GitHub repository access...');

  try {
    ghCommand(['repo', 'view', repository, '--json', 'name']);
    logger.stopSpinner(spinner, `GitHub repository "${repository}" accessible`);

    // Each app's github:sync and deploy workflows need a GitHub Environment per environment.
    const frontend = frontendRepository(config);
    for (const repo of [repository, ...(frontend ? [frontend] : [])]) {
      for (const environment of environments) {
        const outcome = ensureGithubEnvironment(repo, environment);
        logger.success(
          `  GitHub Environment "${environment}" in ${repo} — ${outcome === 'created' ? 'created' : 'already present'}`,
        );
      }
    }

    logger.info(
      'Environment-scoped secrets and variables will be pushed by the GitHub sync step (after .env.<environment> export).',
    );

    return {
      success: true,
      message: 'GitHub: repository access verified',
      stateUpdates: { github: { repository, secrets: [] } },
    };
  } catch (provisionError) {
    const message =
      provisionError instanceof Error ? provisionError.message : String(provisionError);
    logger.error(`GitHub provisioning failed: ${message}`);
    return { success: false, message };
  }
}

export async function check(state: SetupState, config?: SetupConfig): Promise<boolean> {
  const repository = state.github?.repository ?? config?.providers.github.repository;
  if (!repository) {
    logger.error('GitHub: no repository configured');
    return false;
  }

  try {
    ghCommand(['repo', 'view', repository, '--json', 'name']);
    logger.success(`GitHub repository "${repository}" — accessible`);
    return true;
  } catch {
    logger.error(`GitHub repository "${repository}" — inaccessible`);
    return false;
  }
}

function githubTokenPresentInEnvironment(): boolean {
  return Boolean((process.env.GITHUB_TOKEN ?? '').trim() || (process.env.GH_TOKEN ?? '').trim());
}

export async function syncGithubFoundations(environmentNames?: readonly string[]): Promise<void> {
  logger.info('Syncing GitHub branches, rulesets, and environments...');
  const initResult = await runGithubInit({
    mode: 'sync',
    purpose: 'Setup infra: branches, rulesets, and GitHub Environments',
    skipPreflight: githubTokenPresentInEnvironment(),
    ...(environmentNames ? { environmentNames } : {}),
  });
  if (initResult.failures > 0) {
    logger.warn(
      `GitHub branch/ruleset/environment sync reported ${initResult.failures} failure(s). ` +
        'Common cause: repository rulesets need GitHub Pro on private repos. ' +
        'Re-run `pnpm github:sync` after upgrading or making the repo public.',
    );
    return;
  }
  logger.success('GitHub branches, rulesets, and environments are in sync.');
}

export const setupGithubProvider: InfraProvider = {
  key: 'github',
  // release-please needs a real token (a GITHUB_TOKEN-created release does not trigger the deploy
  // workflow), and GitHub has no API to mint one — so the operator's GITHUB_TOKEN is the source.
  toEnvironmentVariables: ({ config, secrets }) =>
    config.providers.github.enabled && secrets.github?.token
      ? { RELEASE_PLEASE_TOKEN: secrets.github.token }
      : {},
  name: 'GitHub (environments)',
  isEnabled: ({ config }) => config.providers.github.enabled,
  disabledReason: () => 'GitHub provider disabled in setup.config.json',
  preview: ({ config }) =>
    config.providers.github.enabled
      ? {
          detail:
            'GITHUB_TOKEN (or gh auth login) — repository access + GitHub Environments in both app repos',
          url: 'https://github.com/settings/tokens',
          configKey: 'GITHUB_TOKEN',
        }
      : null,
  settingsReview: ({ config }) =>
    config.providers.github.enabled
      ? [
          {
            bucket: 'resource',
            provider: 'GitHub',
            detail: `GitHub Environments in ${[config.providers.github.repository, frontendRepository(config)].filter(Boolean).join(' + ')} (${formatGitHubEnvironmentPlan(config)})`,
          },
        ]
      : [],
  describe: ({ config, environments }) => {
    const [owner = '', repository = ''] = config.providers.github.repository.split('/');
    return { organization: owner, project: repository, environments };
  },
  inspectRemote: ({ config, environments }) => {
    const repository = config.providers.github.repository;
    const [owner = '', repo = ''] = repository.split('/');
    const repoResult = runCommand('gh', {
      args: ['api', `repos/${repository}`, '--jq', '.full_name'],
      allowFailure: true,
    });
    if (repoResult.status !== 0) {
      return Promise.resolve({
        present: false,
        fields: [
          {
            label: 'repository',
            expected: repository,
            remote: '—',
            matches: false,
            prerequisite: true,
          },
        ],
        error: repoResult.stderr.trim() || 'repository not found / gh not authenticated',
      });
    }
    const [remoteOwner = '', remoteRepo = ''] = repoResult.stdout.trim().split('/');
    const fields = [
      {
        label: 'owner',
        expected: owner,
        remote: remoteOwner || '—',
        matches: remoteOwner === owner,
        prerequisite: true,
      },
      {
        label: 'repository',
        expected: repo,
        remote: remoteRepo || '—',
        matches: remoteRepo === repo,
      },
    ];
    const envResult = runCommand('gh', {
      args: ['api', `repos/${repository}/environments`, '--jq', '.environments[].name'],
      allowFailure: true,
    });
    const remoteEnvironments = new Set(
      envResult.status === 0 ? envResult.stdout.trim().split('\n').filter(Boolean) : [],
    );
    for (const environmentName of environments) {
      const present = remoteEnvironments.has(environmentName);
      fields.push({
        label: `environment (${environmentName})`,
        expected: environmentName,
        remote: present ? environmentName : '—',
        matches: present,
      });
    }
    return Promise.resolve({ present: true, fields });
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'GitHub (environments)',
    enabled: setupGithubProvider.isEnabled(context),
    enabledReason: setupGithubProvider.disabledReason(context),
    instructions: [
      `Will make sure ${[context.config.providers.github.repository, frontendRepository(context.config)].filter(Boolean).join(' and ')} each have a GitHub Environment for ${context.environments.join(', ')} (created empty when missing).`,
      "Secrets are not pushed here — each app's own `pnpm github:sync` fills its environments (and owns its branches and rulesets).",
    ],
    execute: async () => {
      const result = await provision(
        context.config,
        context.secrets,
        context.state,
        context.environments,
      );
      if (!result.success) throw new Error(result.message);
      context.applyStateUpdates(result.stateUpdates ?? {});
      return result;
    },
    verifyState: () => ({
      ok: Boolean(context.state.github?.repository),
      message: context.state.github?.repository
        ? `repository ${context.state.github.repository} verified (environments)`
        : 'no GitHub repository recorded',
    }),
    verifyLive: async () => {
      const ok = await check(context.state, context.config);
      return { ok, message: ok ? 'reachable' : 'unreachable' };
    },
  }),
  detectRemote: async ({ config, state, applyStateUpdates }) => {
    const resources: Record<string, unknown> = {};
    try {
      const repository = config.providers.github.repository;
      const probe = runCommand('gh', {
        args: ['api', `repos/${repository}`, '--jq', '.name'],
        timeoutMs: 10_000,
        allowFailure: true,
      });
      if (probe.status !== 0) throw new Error('repository not accessible');
      resources.repository = repository;
    } catch {
      // repository not accessible, skip
    }
    if (Object.keys(resources).length > 0) {
      // Merge into existing github state — the schema requires `secrets:
      // string[]` and overwriting with just { repository } would invalidate
      // the file and force a "starting fresh" wipe on the next loadState.
      const repository = resources.repository as string | undefined;
      applyStateUpdates({
        github: {
          repository: repository ?? state.github?.repository ?? config.providers.github.repository,
          secrets: state.github?.secrets ?? [],
        },
      });
    }
    return resources;
  },
  check: ({ state, config }) => check(state, config),
  deleteInstructions: ({ state, config }) => {
    const repository = state.github?.repository ?? config.providers.github.repository;
    if (!repository) return [];
    const secrets = state.github?.secrets ?? [];
    const environments = config.environments.map((environment) => environment.name);
    return [
      {
        provider: 'GitHub (environments)',
        dashboardUrl: `https://github.com/${repository}/settings/environments`,
        steps: [
          'Settings → Environments → delete each environment listed below.',
          'Settings → Secrets and variables → Actions → remove repo and environment secrets you no longer need.',
          'Settings → Rules / Branches → remove the branch rulesets pushed by setup:infra.',
          'The repository itself is intentionally not deleted by these instructions; remove it from Settings → Danger Zone if you really want to drop it.',
        ],
        resources: [
          { label: 'Repository', identifier: repository },
          ...environments.map((environmentName) => ({
            label: 'Environment',
            identifier: environmentName,
          })),
          ...(secrets.length > 0
            ? [{ label: 'Synced secrets', identifier: secrets.join(', ') }]
            : []),
        ],
      },
    ];
  },
};
