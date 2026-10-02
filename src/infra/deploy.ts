/**
 * `pnpm setup:infra:deploy` — ship both apps after setup, in one command instead of a list of `gh`
 * calls. Three steps, each app in turn:
 *
 *   1. Artifact attestations. GitHub stores them for a private repository only on Enterprise
 *      Cloud; elsewhere every attest step fails the build. Sets the repository variable
 *      ARTIFACT_ATTESTATIONS=disabled where the plan can't store them (both apps' attest steps
 *      skip with a warning), and removes it where the plan can.
 *   2. Post-merge CI. Re-runs the failed jobs of the latest post-merge run on `main` — that run
 *      deploys the development environment.
 *   3. Production (`--production` only). Runs each app's release-deploy.yml FROM `main` with its
 *      latest release tag: the production environment accepts protected branches only, so a
 *      published release does not deploy by itself.
 *
 * NAMING (single source of truth = setup.config.json): the repositories come from
 * `providers.github.repository` and `frontendRepository(config)`.
 */
import { createInterface } from 'node:readline';
import { frontendRepository } from '@setup/common/config.js';
import * as logger from '@setup/common/logger.js';
import { isAssumeYes, question } from '@setup/common/prompts.js';
import { SetupError } from '@setup/common/setup-error.js';
import type { SetupConfig } from '@setup/common/types.js';
import { ghTry } from '@setup/github/gh.js';

export const ATTESTATIONS_VARIABLE = 'ARTIFACT_ATTESTATIONS';
const POST_MERGE_WORKFLOW = 'post-merge-ci.yml';
const RELEASE_DEPLOY_WORKFLOW = 'release-deploy.yml';
const TRUNK = 'main';

export type PlanSupport = 'supported' | 'unsupported' | 'unknown';

/**
 * Can GitHub store artifact attestations for this repository? Public repositories: every plan.
 * Private: only an organization on Enterprise. `ownerPlan` is undefined when the login can't read
 * the organization's plan (only organization owners can).
 */
export function attestationSupport(repository: {
  readonly isPrivate: boolean;
  readonly ownerType: string;
  readonly ownerPlan?: string | undefined;
}): PlanSupport {
  if (!repository.isPrivate) return 'supported';
  if (repository.ownerType !== 'Organization') return 'unsupported';
  if (repository.ownerPlan === undefined) return 'unknown';
  return repository.ownerPlan === 'enterprise' ? 'supported' : 'unsupported';
}

export interface WorkflowRun {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
}

/** The GitHub calls the command makes — injectable, so the flow is testable without network. */
export interface DeployGithub {
  repository(
    repository: string,
  ): { isPrivate: boolean; ownerType: string; ownerLogin: string } | undefined;
  organizationPlan(organization: string): string | undefined;
  variable(repository: string, name: string): string | undefined;
  setVariable(repository: string, name: string, value: string): void;
  deleteVariable(repository: string, name: string): void;
  latestRun(repository: string, workflow: string, branch: string): WorkflowRun | undefined;
  rerunFailedJobs(repository: string, runId: number): void;
  latestRelease(repository: string): string | undefined;
  openReleasePullRequest(repository: string): { number: number; title: string } | undefined;
  dispatch(repository: string, workflow: string, ref: string, inputs: Record<string, string>): void;
}

export interface DeployOptions {
  /** Also deploy each app's latest release (or `tag`) to production. */
  readonly production?: boolean;
  /** Release tag to deploy — needs `app`, since the apps version independently. */
  readonly tag?: string | undefined;
  /** `backend` or `frontend`; both when omitted. */
  readonly app?: string | undefined;
}

interface App {
  readonly label: 'backend' | 'frontend';
  readonly repository: string;
}

function selectedApps(config: SetupConfig, options: DeployOptions): App[] {
  const frontend = frontendRepository(config);
  const apps: App[] = [
    { label: 'backend', repository: config.providers.github.repository },
    ...(frontend ? [{ label: 'frontend' as const, repository: frontend }] : []),
  ];
  const app = options.app?.toLowerCase();
  if (app && app !== 'backend' && app !== 'frontend') {
    throw new SetupError(`--app must be backend or frontend (got "${options.app}").`);
  }
  const selected = app ? apps.filter((entry) => entry.label === app) : apps;
  if (options.tag && !app) {
    throw new SetupError('--tag needs --app backend|frontend — the apps version independently.');
  }
  return selected;
}

/** Step 1 for one app: make ARTIFACT_ATTESTATIONS match what the plan can store. */
export function reconcileAttestations(github: DeployGithub, app: App): string {
  const repository = github.repository(app.repository);
  if (!repository) return `? ${app.repository}: can't read the repository — left unchanged`;
  const ownerPlan =
    repository.isPrivate && repository.ownerType === 'Organization'
      ? github.organizationPlan(repository.ownerLogin)
      : undefined;
  const support = attestationSupport({ ...repository, ownerPlan });
  const current = github.variable(app.repository, ATTESTATIONS_VARIABLE);
  if (support === 'unknown') {
    return `? ${app.repository}: can't read the organization's plan — ${ATTESTATIONS_VARIABLE} left ${current ?? 'unset'}`;
  }
  if (support === 'unsupported') {
    if (current !== 'disabled')
      github.setVariable(app.repository, ATTESTATIONS_VARIABLE, 'disabled');
    return `✓ ${app.repository}: ${ATTESTATIONS_VARIABLE}=disabled — private repository on ${ownerPlan ?? 'a personal plan'}; attestations need GitHub Enterprise Cloud${current === 'disabled' ? ' (already set)' : ''}`;
  }
  if (current !== undefined) github.deleteVariable(app.repository, ATTESTATIONS_VARIABLE);
  return `✓ ${app.repository}: attestations on${current !== undefined ? ` (removed ${ATTESTATIONS_VARIABLE}=${current})` : ''}`;
}

/** Step 2 for one app: re-run the failed jobs of the latest post-merge run on main. */
export function rerunPostMerge(github: DeployGithub, app: App): string {
  const run = github.latestRun(app.repository, POST_MERGE_WORKFLOW, TRUNK);
  if (!run) return `? ${app.repository}: no post-merge run on ${TRUNK} yet — merge a pull request`;
  if (run.status !== 'completed')
    return `… ${app.repository}: post-merge run ${run.status} — ${run.url}`;
  if (run.conclusion === 'success')
    return `✓ ${app.repository}: latest post-merge run passed — ${run.url}`;
  github.rerunFailedJobs(app.repository, run.id);
  return `↻ ${app.repository}: re-running the failed jobs (was ${run.conclusion}) — ${run.url}`;
}

async function confirmProduction(prompt: string): Promise<boolean> {
  if (isAssumeYes()) return true;
  if (!process.stdin.isTTY) return false;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test(await question(readline, `${prompt} [y/N]`, ''));
  } finally {
    readline.close();
  }
}

/** Step 3 for one app: run release-deploy.yml from main with the release tag. */
export async function deployProduction(
  github: DeployGithub,
  app: App,
  tag: string | undefined,
  confirm: (prompt: string) => Promise<boolean> = confirmProduction,
): Promise<string> {
  const release = tag ?? github.latestRelease(app.repository);
  if (!release) {
    const pending = github.openReleasePullRequest(app.repository);
    return `✗ ${app.repository}: no release yet — ${pending ? `merge #${pending.number} (${pending.title}) first` : 'merge its release-please Release PR first'}`;
  }
  if (!(await confirm(`Deploy ${app.repository} ${release} to production?`))) {
    return `– ${app.repository}: ${release} not deployed${process.stdin.isTTY || isAssumeYes() ? '' : ' (no terminal — add --yes)'}`;
  }
  github.dispatch(app.repository, RELEASE_DEPLOY_WORKFLOW, TRUNK, { tag: release });
  return `✓ ${app.repository}: deploying ${release} to production — gh run list --repo ${app.repository} --workflow ${RELEASE_DEPLOY_WORKFLOW}`;
}

/** `gh` with JSON output → parsed value; undefined on any failure (404 included). */
function ghJsonOrUndefined<T>(args: string[]): T | undefined {
  const result = ghTry(args, { timeoutMs: 20_000 });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

function ghWrite(args: string[]): void {
  const result = ghTry(args, { timeoutMs: 30_000 });
  if (result.status !== 0) {
    throw new SetupError(
      `gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

/** The real GitHub, through the `gh` CLI (GITHUB_TOKEN when set, otherwise `gh auth login`). */
export const ghDeployGithub: DeployGithub = {
  repository: (repository) => {
    const repo = ghJsonOrUndefined<{
      private?: boolean;
      owner?: { login?: string; type?: string };
    }>(['api', `repos/${repository}`]);
    if (!repo?.owner?.login) return undefined;
    return {
      isPrivate: repo.private === true,
      ownerType: repo.owner.type ?? 'User',
      ownerLogin: repo.owner.login,
    };
  },
  organizationPlan: (organization) =>
    ghJsonOrUndefined<{ plan?: { name?: string } }>(['api', `orgs/${organization}`])?.plan?.name,
  variable: (repository, name) =>
    ghJsonOrUndefined<{ value?: string }>(['api', `repos/${repository}/actions/variables/${name}`])
      ?.value,
  setVariable: (repository, name, value) =>
    ghWrite(['variable', 'set', name, '--body', value, '--repo', repository]),
  deleteVariable: (repository, name) => ghWrite(['variable', 'delete', name, '--repo', repository]),
  latestRun: (repository, workflow, branch) =>
    ghJsonOrUndefined<
      Array<{ databaseId: number; status: string; conclusion: string; url: string }>
    >([
      'run',
      'list',
      '--repo',
      repository,
      '--workflow',
      workflow,
      '--branch',
      branch,
      '--limit',
      '1',
      '--json',
      'databaseId,status,conclusion,url',
    ])
      ?.map((run) => ({
        id: run.databaseId,
        status: run.status,
        conclusion: run.conclusion,
        url: run.url,
      }))
      .at(0),
  rerunFailedJobs: (repository, runId) =>
    ghWrite(['run', 'rerun', String(runId), '--failed', '--repo', repository]),
  latestRelease: (repository) =>
    ghJsonOrUndefined<Array<{ tagName: string }>>([
      'release',
      'list',
      '--repo',
      repository,
      '--exclude-drafts',
      '--exclude-pre-releases',
      '--limit',
      '1',
      '--json',
      'tagName',
    ])?.at(0)?.tagName,
  openReleasePullRequest: (repository) =>
    ghJsonOrUndefined<Array<{ number: number; title: string }>>([
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--label',
      'autorelease: pending',
      '--limit',
      '1',
      '--json',
      'number,title',
    ])?.at(0),
  dispatch: (repository, workflow, ref, inputs) =>
    ghWrite([
      'workflow',
      'run',
      workflow,
      '--repo',
      repository,
      '--ref',
      ref,
      ...Object.entries(inputs).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
    ]),
};

/** Run the three steps for the selected apps and print one line per app per step. */
export async function runDeploy(
  config: SetupConfig,
  options: DeployOptions = {},
  github: DeployGithub = ghDeployGithub,
): Promise<void> {
  const apps = selectedApps(config, options);
  logger.stepHeader(1, 3, 'Artifact attestations');
  for (const app of apps) logger.infoRaw(reconcileAttestations(github, app));
  logger.stepHeader(2, 3, `Post-merge CI on ${TRUNK} (deploys development)`);
  for (const app of apps) logger.infoRaw(rerunPostMerge(github, app));
  logger.stepHeader(3, 3, 'Production');
  if (!options.production) {
    logger.infoRaw(
      `– skipped. After merging each app's Release PR: pnpm setup:infra:deploy --production`,
    );
  } else {
    for (const app of apps) logger.infoRaw(await deployProduction(github, app, options.tag));
  }
  logger.blank();
}
