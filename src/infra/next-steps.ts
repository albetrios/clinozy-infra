/**
 * The "what's left" checklist: the steps setup cannot do itself, in the order to do them, each with
 * its live status where it can be checked. Printed at the end of `pnpm setup:infra` and on its own
 * by `pnpm setup:infra:next`.
 *
 * DNS records come from the providers that need them (collected during a run) and are saved to
 * `.setup/next-steps.json` — public values, not secrets — so the standalone command can re-check
 * them without provisioning anything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveCname, resolveMx, resolveTxt } from 'node:dns/promises';
import chalk from 'chalk';
import { type DnsRequirement, collectedDnsRequirements } from '@setup/common/dns-requirements.js';
import * as logger from '@setup/common/logger.js';
import { frontendRootIfExists, targetRoot, toolPath } from '@setup/common/paths.js';
import { ensureSecretDir } from '@setup/common/secure-file.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import type { SetupConfig, SetupSecrets } from '@setup/common/types.js';
import { oauthCallbackUrl } from '@setup/envs/env-file-setup.util.js';
import { readEnvFileValue } from '@setup/envs/read-env-file.js';
import { backendRoleName } from '@setup/infra/providers/setup-neon/setup-neon.provider.js';

export type StepStatus = 'done' | 'todo' | 'manual';

export interface NextStep {
  readonly title: string;
  readonly status: StepStatus;
  /** Lines shown under the step: instructions, commands, per-item checks. */
  readonly lines: readonly string[];
}

/** Live checks, injectable so the checklist logic is testable without network. */
export interface NextStepChecks {
  dnsRecordLive(record: DnsRequirement): Promise<boolean>;
  githubEnvironmentHasSecrets(
    repository: string,
    environment: string,
  ): Promise<boolean | undefined>;
  repositoryIsPrivate(repository: string): Promise<boolean | undefined>;
  envValue(environment: string, key: string): string | undefined;
}

const NEXT_STEPS_FILE = (): string => toolPath('.setup', 'next-steps.json');

/** Persist the DNS requirements collected this run (merged with any saved earlier). */
export function saveDnsRequirements(records: readonly DnsRequirement[]): void {
  if (records.length === 0) return;
  ensureSecretDir(NEXT_STEPS_FILE());
  writeFileSync(
    NEXT_STEPS_FILE(),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), dnsRecords: records }, null, 2)}\n`,
  );
}

function loadDnsRequirements(): DnsRequirement[] {
  try {
    if (!existsSync(NEXT_STEPS_FILE())) return [];
    const parsed = JSON.parse(readFileSync(NEXT_STEPS_FILE(), 'utf-8')) as {
      dnsRecords?: DnsRequirement[];
    };
    return parsed.dnsRecords ?? [];
  } catch {
    return [];
  }
}

const bareHost = (value: string): string => value.replace(/\.$/, '').toLowerCase();

/** Public DNS lookup: does the record exist with the required value? */
export async function dnsRecordLive(record: DnsRequirement): Promise<boolean> {
  try {
    if (record.type === 'CNAME') {
      return (await resolveCname(record.name)).some(
        (value) => bareHost(value) === bareHost(record.value),
      );
    }
    if (record.type === 'TXT') {
      return (await resolveTxt(record.name)).some((parts) => parts.join('') === record.value);
    }
    return (await resolveMx(record.name)).some(
      (entry) => bareHost(entry.exchange) === bareHost(record.value),
    );
  } catch {
    return false;
  }
}

function liveChecks(secrets: SetupSecrets): NextStepChecks {
  const token = secrets.github?.token;
  const github = async (path: string) =>
    token
      ? setupFetch({
          name: 'GitHub',
          url: `https://api.github.com/${path}`,
          init: {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'clinozy-infra-setup',
            },
          },
          expectedStatus: [200, 404],
        })
      : undefined;
  return {
    dnsRecordLive,
    githubEnvironmentHasSecrets: async (repository, environment) => {
      try {
        const response = await github(`repos/${repository}/environments/${environment}/secrets`);
        if (response?.status !== 200) return undefined;
        return ((await response.json()) as { total_count?: number }).total_count !== 0;
      } catch {
        return undefined;
      }
    },
    repositoryIsPrivate: async (repository) => {
      try {
        const response = await github(`repos/${repository}`);
        if (response?.status !== 200) return undefined;
        return ((await response.json()) as { private?: boolean }).private === true;
      } catch {
        return undefined;
      }
    },
    envValue: (environment, key) => readEnvFileValue(environment, key),
  };
}

const mark = (ok: boolean | undefined): string => (ok === true ? '✓' : ok === false ? '✗' : '?');

/** Build the ordered checklist. */
export async function buildNextSteps(options: {
  config: SetupConfig;
  dnsRecords: readonly DnsRequirement[];
  checks: NextStepChecks;
  backendPath?: string | undefined;
  frontendPath?: string | undefined;
}): Promise<NextStep[]> {
  const { config, dnsRecords, checks } = options;
  const environments = config.environments.map((environment) => environment.name);
  const steps: NextStep[] = [];

  // 1. Domain + DNS.
  const domain = config.product?.domain;
  if (dnsRecords.length > 0) {
    const results = await Promise.all(dnsRecords.map((record) => checks.dnsRecordLive(record)));
    steps.push({
      title: `Register ${domain ?? 'the domain'} and create these DNS records at your DNS host`,
      status: results.every(Boolean) ? 'done' : 'todo',
      lines: dnsRecords.map(
        (record, index) =>
          `${mark(results[index])} ${record.type.padEnd(5)} ${record.name} → ${record.value}${record.priority ? ` (priority ${record.priority})` : ''}   [${record.provider}]`,
      ),
    });
  } else if (domain) {
    steps.push({
      title: `Register ${domain} and create its DNS records`,
      status: 'todo',
      lines: ['Run `pnpm setup:infra` once — each provider reports the records it needs here.'],
    });
  }

  // 2. GitHub App callback URLs — GitHub has no API for them.
  if (config.providers.oauth.github.enabled) {
    steps.push({
      title: 'Add the sign-in callback URLs to your GitHub App',
      status: 'manual',
      lines: [
        'github.com → Settings → Developer settings → GitHub Apps → (your sign-in app) → Callback URLs:',
        ...environments.map(
          (environment) =>
            `  ${environment}: ${oauthCallbackUrl(config, environment, 'github') || '—'}`,
        ),
      ],
    });
  }

  // 3. GitHub Environments — each app's own sync pushes its .env.<env>.
  const backendRepository = config.providers.github.repository;
  const owner = backendRepository.split('/')[0];
  const frontendRepository = config.frontend?.name ? `${owner}/${config.frontend.name}` : undefined;
  const repositories = [backendRepository, ...(frontendRepository ? [frontendRepository] : [])];
  const synced = await Promise.all(
    repositories.flatMap((repository) =>
      environments.map(async (environment) => ({
        label: `${repository} · ${environment}`,
        ok: await checks.githubEnvironmentHasSecrets(repository, environment),
      })),
    ),
  );
  steps.push({
    title: 'Push the env files to GitHub Environments (each app runs its own sync)',
    status: synced.every((entry) => entry.ok === true) ? 'done' : 'todo',
    lines: [
      `cd ${options.backendPath ?? '../<backend>'} && pnpm github:sync`,
      ...(frontendRepository
        ? [`cd ${options.frontendPath ?? '../<frontend>'} && pnpm github:sync`]
        : []),
      ...synced.map((entry) => `${mark(entry.ok)} ${entry.label} has secrets`),
    ],
  });

  // 4. Backend database users — created by setup once the backend's migrations ran.
  const migrator = backendRoleName(config, 'migrator');
  const userStatus = environments.map((environment) => {
    const migrationUser = (() => {
      try {
        return decodeURIComponent(
          new URL(checks.envValue(environment, 'DATABASE_MIGRATION_URL') ?? '').username,
        );
      } catch {
        return '';
      }
    })();
    const ok =
      Boolean(checks.envValue(environment, 'DATABASE_MAINTENANCE_URL')) &&
      migrationUser === migrator;
    return { environment, ok };
  });
  steps.push({
    title: "Backend database users (runtime, maintenance, migrator) — the backend's runbook roles",
    status: userStatus.every((entry) => entry.ok) ? 'done' : 'todo',
    lines: [
      ...userStatus.map(
        (entry) =>
          `${mark(entry.ok)} ${entry.environment}: DATABASE_URL · DATABASE_MAINTENANCE_URL · DATABASE_MIGRATION_URL (${migrator})`,
      ),
      ...(userStatus.every((entry) => entry.ok)
        ? []
        : [
            'Created automatically once the backend migrations have run (setup bootstraps them on a fresh',
            'database). Re-run: SETUP_INFRA_PROVIDERS=neon pnpm setup:infra --yes',
          ]),
    ],
  });

  // 5. Build attestations on a private repository.
  if ((await checks.repositoryIsPrivate(backendRepository)) === true) {
    steps.push({
      title: 'Decide on the backend build attestations (private repository)',
      status: 'manual',
      lines: [
        'GitHub stores artifact attestations for private repositories only on GitHub Enterprise Cloud;',
        "on other plans the backend's attest steps fail the image build. Upgrade the plan, make the",
        'repository public, or gate those steps.',
      ],
    });
  }

  // 6–7. Deploy.
  steps.push({
    title: 'First deploy — merge to main in each app',
    status: 'manual',
    lines: [
      'Backend: post-merge CI → image → Railway development (migrate → seed → API → worker).',
      'Frontend: post-merge CI → Netlify development alias.',
    ],
  });
  steps.push({
    title: "Go live — merge each app's release-please Release PR",
    status: 'manual',
    lines: ['Triggers release-deploy → Railway production / Netlify production.'],
  });
  return steps;
}

/** Print the checklist, one numbered step at a time. */
export function printNextSteps(steps: readonly NextStep[]): void {
  logger.blank();
  logger.infoRaw(chalk.bold('Next steps — do these one by one'));
  steps.forEach((step, index) => {
    const badge =
      step.status === 'done'
        ? chalk.green('[done]')
        : step.status === 'todo'
          ? chalk.yellow('[todo]')
          : chalk.cyan('[you]');
    logger.infoRaw(`  ${index + 1}. ${badge} ${step.title}`);
    for (const line of step.lines) logger.infoRaw(`       ${line}`);
  });
  logger.blank();
}

/** Build, persist (DNS) and print — used at the end of a run and by `pnpm setup:infra:next`. */
export async function runNextSteps(config: SetupConfig, secrets: SetupSecrets): Promise<void> {
  const collected = collectedDnsRequirements();
  if (collected.length > 0) saveDnsRequirements(collected);
  const steps = await buildNextSteps({
    config,
    dnsRecords: collected.length > 0 ? collected : loadDnsRequirements(),
    checks: liveChecks(secrets),
    backendPath: (() => {
      try {
        return targetRoot();
      } catch {
        return undefined;
      }
    })(),
    frontendPath: frontendRootIfExists(),
  });
  printNextSteps(steps);
}
