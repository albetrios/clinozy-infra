/**
 * `pnpm setup:infra:deploy`: the attestations switch follows the plan, a failed post-merge run is
 * re-run, and production deploys only a real release, from main, after confirmation. GitHub is a
 * fake — no network.
 */
import { describe, expect, it } from 'vitest';
import {
  ATTESTATIONS_VARIABLE,
  type DeployGithub,
  type WorkflowRun,
  attestationSupport,
  deployProduction,
  reconcileAttestations,
  rerunPostMerge,
  runDeploy,
} from '@setup/infra/deploy.js';
import { buildConfig } from '@setup/infra/init-wizard.js';

const config = () =>
  buildConfig('acme-org', 'acme-be', 'Acme Backend', ['development', 'production']);

const backend = { label: 'backend', repository: 'acme/acme-api' } as const;

function fakeGithub(state: {
  login?: string;
  isPrivate?: boolean;
  plan?: string;
  variable?: string;
  run?: WorkflowRun;
  release?: string;
  releasePullRequest?: { number: number; title: string };
}) {
  const calls: string[] = [];
  const github: DeployGithub = {
    login: () => state.login ?? 'operator',
    repository: () => ({
      isPrivate: state.isPrivate ?? true,
      ownerType: 'Organization',
      ownerLogin: 'acme',
    }),
    organizationPlan: () => state.plan,
    variable: () => state.variable,
    setVariable: (repository, name, value) => calls.push(`set ${repository} ${name}=${value}`),
    deleteVariable: (repository, name) => calls.push(`delete ${repository} ${name}`),
    latestRun: () => state.run,
    rerunFailedJobs: (repository, runId) => calls.push(`rerun ${repository} ${runId}`),
    latestRelease: () => state.release,
    openReleasePullRequest: () => state.releasePullRequest,
    dispatch: (repository, workflow, ref, inputs) =>
      calls.push(`dispatch ${repository} ${workflow} ${ref} tag=${inputs.tag}`),
  };
  return { github, calls };
}

describe('attestationSupport', () => {
  it('public anywhere, private only on Enterprise, unknown without the plan', () => {
    expect(
      attestationSupport({ isPrivate: false, ownerType: 'Organization', ownerPlan: 'free' }),
    ).toBe('supported');
    expect(
      attestationSupport({ isPrivate: true, ownerType: 'Organization', ownerPlan: 'enterprise' }),
    ).toBe('supported');
    expect(
      attestationSupport({ isPrivate: true, ownerType: 'Organization', ownerPlan: 'team' }),
    ).toBe('unsupported');
    expect(attestationSupport({ isPrivate: true, ownerType: 'User' })).toBe('unsupported');
    expect(attestationSupport({ isPrivate: true, ownerType: 'Organization' })).toBe('unknown');
  });
});

describe('reconcileAttestations', () => {
  it('disables attestations on a private repository whose plan cannot store them', () => {
    const { github, calls } = fakeGithub({ plan: 'team' });
    expect(reconcileAttestations(github, backend)).toMatch(/ARTIFACT_ATTESTATIONS=disabled/);
    expect(calls).toEqual([`set acme/acme-api ${ATTESTATIONS_VARIABLE}=disabled`]);
  });

  it('writes nothing when it is already disabled', () => {
    const { github, calls } = fakeGithub({ plan: 'team', variable: 'disabled' });
    expect(reconcileAttestations(github, backend)).toMatch(/already set/);
    expect(calls).toEqual([]);
  });

  it('removes the switch once the plan supports attestations', () => {
    const { github, calls } = fakeGithub({ plan: 'enterprise', variable: 'disabled' });
    reconcileAttestations(github, backend);
    expect(calls).toEqual([`delete acme/acme-api ${ATTESTATIONS_VARIABLE}`]);
  });

  it("leaves it alone when the login can't read the plan", () => {
    const { github, calls } = fakeGithub({});
    expect(reconcileAttestations(github, backend)).toMatch(/^\?/);
    expect(calls).toEqual([]);
  });
});

describe('rerunPostMerge', () => {
  const run = (conclusion: string, status = 'completed'): WorkflowRun => ({
    id: 42,
    status,
    conclusion,
    url: 'https://github.com/acme/acme-api/actions/runs/42',
  });

  it('re-runs the failed jobs of a failed run, and nothing else', () => {
    const failed = fakeGithub({ run: run('failure') });
    expect(rerunPostMerge(failed.github, backend)).toMatch(/re-running/);
    expect(failed.calls).toEqual(['rerun acme/acme-api 42']);

    for (const state of [{ run: run('success') }, { run: run('', 'in_progress') }, {}]) {
      const other = fakeGithub(state);
      rerunPostMerge(other.github, backend);
      expect(other.calls).toEqual([]);
    }
  });
});

describe('deployProduction', () => {
  const yes = async () => true;

  it('deploys the latest release from main', async () => {
    const { github, calls } = fakeGithub({ release: 'v7.1.0' });
    expect(await deployProduction(github, backend, undefined, yes)).toMatch(/deploying v7.1.0/);
    expect(calls).toEqual(['dispatch acme/acme-api release-deploy.yml main tag=v7.1.0']);
  });

  it('points at the Release PR when there is no release yet', async () => {
    const { github, calls } = fakeGithub({
      releasePullRequest: { number: 21, title: 'chore(main): release 7.1.0' },
    });
    expect(await deployProduction(github, backend, undefined, yes)).toMatch(/merge #21/);
    expect(calls).toEqual([]);
  });

  it('deploys nothing without confirmation', async () => {
    const { github, calls } = fakeGithub({ release: 'v7.1.0' });
    await deployProduction(github, backend, undefined, async () => false);
    expect(calls).toEqual([]);
  });
});

describe('runDeploy', () => {
  it('needs --app with --tag, since the apps version independently', async () => {
    const { github } = fakeGithub({});
    await expect(runDeploy(config(), { tag: 'v1.0.0' }, github)).rejects.toThrow(/--app/);
    await expect(runDeploy(config(), { app: 'api' }, github)).rejects.toThrow(
      /backend or frontend/,
    );
  });

  it("refuses to run without the operator's own gh login", async () => {
    const { github, calls } = fakeGithub({ login: '' });
    await expect(runDeploy(config(), {}, github)).rejects.toThrow(/gh auth login/);
    expect(calls).toEqual([]);
  });

  it('never touches production without --production', async () => {
    const { github, calls } = fakeGithub({ plan: 'team', release: 'v1.0.0' });
    await runDeploy(config(), {}, github);
    expect(calls.some((call) => call.startsWith('dispatch'))).toBe(false);
  });
});
