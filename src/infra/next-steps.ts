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
import { frontendRepository } from '@setup/common/config.js';
import { type DnsRequirement, collectedDnsRequirements } from '@setup/common/dns-requirements.js';
import * as logger from '@setup/common/logger.js';
import { frontendRootIfExists, targetRoot, toolPath } from '@setup/common/paths.js';
import { ensureSecretDir } from '@setup/common/secure-file.js';
import type { SetupConfig } from '@setup/common/types.js';
import { backendOriginForEnvironment, oauthCallbackUrl } from '@setup/envs/env-file-setup.util.js';
import { readEnvFileValue } from '@setup/envs/read-env-file.js';
import { ghTry } from '@setup/github/gh.js';
import { backendRoleName } from '@setup/infra/providers/setup-neon/setup-neon.provider.js';
import { STRIPE_WEBHOOK_EVENTS, STRIPE_WEBHOOK_PATH } from '@setup/presets/stripe.preset.js';

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

const bareHost = (value: string): string => value.replace(/\.$/, '').toLowerCase();

const recordKey = (record: DnsRequirement): string => `${record.type} ${record.name.toLowerCase()}`;

/**
 * Records collected this run win over saved ones with the same type and name; saved records this
 * run did not report are kept, so a provider that failed mid-run does not drop its records — unless
 * they no longer belong to `domain` (after a domain change they would otherwise stay ✗ forever).
 */
export function mergeDnsRequirements(
  saved: readonly DnsRequirement[],
  collected: readonly DnsRequirement[],
  domain?: string,
): DnsRequirement[] {
  const fresh = new Set(collected.map(recordKey));
  const current = (record: DnsRequirement): boolean => {
    if (!domain) return true;
    const name = bareHost(record.name);
    const base = bareHost(domain);
    return name === base || name.endsWith(`.${base}`);
  };
  return [
    ...collected,
    ...saved.filter((record) => !fresh.has(recordKey(record)) && current(record)),
  ];
}

/** Persist the DNS requirements collected this run (merged with any saved earlier). */
export function saveDnsRequirements(
  records: readonly DnsRequirement[],
  domain?: string,
): DnsRequirement[] {
  const merged = mergeDnsRequirements(loadDnsRequirements(), records, domain);
  if (records.length === 0) return merged;
  ensureSecretDir(NEXT_STEPS_FILE());
  writeFileSync(
    NEXT_STEPS_FILE(),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), dnsRecords: merged }, null, 2)}\n`,
  );
  return merged;
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

/**
 * `gh api <path>` → parsed JSON, `'missing'` for HTTP 404, undefined for any other failure. Goes
 * through the GitHub CLI so it uses the same login as the rest of setup: GITHUB_TOKEN when set,
 * otherwise `gh auth login`.
 */
function githubApi(path: string): unknown | 'missing' | undefined {
  const result = ghTry(['api', path], { timeoutMs: 15_000 });
  if (result.status === 0) {
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      return undefined;
    }
  }
  return /HTTP 404/.test(`${result.stderr}${result.stdout}`) ? 'missing' : undefined;
}

function liveChecks(): NextStepChecks {
  return {
    dnsRecordLive,
    githubEnvironmentHasSecrets: async (repository, environment) => {
      const secrets = githubApi(`repos/${repository}/environments/${environment}/secrets`);
      // 404: the Environment does not exist yet (no secrets either) — when the repository itself
      // is visible; otherwise the login simply cannot see it.
      if (secrets === 'missing') {
        const repo = githubApi(`repos/${repository}`);
        return repo && repo !== 'missing' ? false : undefined;
      }
      if (!secrets) return undefined;
      return (secrets as { total_count?: number }).total_count !== 0;
    },
    repositoryIsPrivate: async (repository) => {
      const repo = githubApi(`repos/${repository}`);
      if (!repo || repo === 'missing') return undefined;
      return (repo as { private?: boolean }).private === true;
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

  // 2. Backend database users — created by setup; the backend's deploy runs migrations as the migrator.
  const appRole = backendRoleName(config, 'app');
  const maintenanceRole = backendRoleName(config, 'maintenance');
  const migratorRole = backendRoleName(config, 'migrator');
  const userOf = (environment: string, key: string): string => {
    try {
      return decodeURIComponent(new URL(checks.envValue(environment, key) ?? '').username);
    } catch {
      return '';
    }
  };
  const userStatus = environments.map((environment) => ({
    environment,
    ok:
      userOf(environment, 'DATABASE_URL') === appRole &&
      userOf(environment, 'DATABASE_MAINTENANCE_URL') === maintenanceRole &&
      userOf(environment, 'DATABASE_MIGRATION_URL') === migratorRole,
  }));
  steps.push({
    title: 'Backend database users (runtime, maintenance, migrations)',
    status: userStatus.every((entry) => entry.ok) ? 'done' : 'todo',
    lines: [
      ...userStatus.map(
        (entry) =>
          `${mark(entry.ok)} ${entry.environment}: DATABASE_URL (${appRole}) · DATABASE_MAINTENANCE_URL (${maintenanceRole}) · DATABASE_MIGRATION_URL (${migratorRole})`,
      ),
      ...(userStatus.every((entry) => entry.ok)
        ? []
        : ['Created by setup: SETUP_INFRA_PROVIDERS=neon pnpm setup:infra --yes']),
    ],
  });

  // 3. Sign-in callback URLs — neither GitHub nor Google has an API for them.
  const has = (environment: string, key: string): boolean =>
    Boolean(checks.envValue(environment, key));
  const { github: githubSignIn, google: googleSignIn } = config.providers.oauth;
  if (githubSignIn.enabled || googleSignIn.enabled) {
    const googleCredentials = environments.map((environment) => ({
      environment,
      ok:
        has(environment, 'OAUTH_GOOGLE_CLIENT_ID') &&
        has(environment, 'OAUTH_GOOGLE_CLIENT_SECRET'),
    }));
    const callbackLines = (provider: 'github' | 'google') =>
      environments.map(
        (environment) =>
          `  ${environment}: ${oauthCallbackUrl(config, environment, provider) || '—'}`,
      );
    steps.push({
      title: 'Register the sign-in callback URLs with each OAuth provider',
      status:
        googleSignIn.enabled && !googleCredentials.every((entry) => entry.ok) ? 'todo' : 'manual',
      lines: [
        ...(githubSignIn.enabled
          ? [
              'GitHub: github.com → Settings → Developer settings → GitHub Apps → (your sign-in app) → Callback URLs:',
              ...callbackLines('github'),
            ]
          : []),
        ...(googleSignIn.enabled
          ? [
              'Google: console.cloud.google.com/apis/credentials → the Web OAuth client of each environment → Authorized redirect URIs:',
              ...callbackLines('google'),
              ...googleCredentials.map(
                (entry) =>
                  `${mark(entry.ok)} ${entry.environment}: OAUTH_GOOGLE_CLIENT_ID · OAUTH_GOOGLE_CLIENT_SECRET in .env.${entry.environment}`,
              ),
              ...(googleCredentials.every((entry) => entry.ok)
                ? []
                : [
                    'Put them in .setup/.setup-credentials as OAUTH_GOOGLE_CLIENT_ID__<environment> / _CLIENT_SECRET__<environment>, then: SETUP_INFRA_PROVIDERS=google-oauth pnpm setup:infra --yes',
                  ]),
            ]
          : []),
      ],
    });
  }

  // 4. Stripe — no API mints keys; the webhook endpoint must point at this deployment's API.
  if (config.providers.stripe.enabled) {
    const stripeKeys = environments.map((environment) => {
      const secretKey = checks.envValue(environment, 'STRIPE_SECRET_KEY') ?? '';
      const production =
        config.environments.find((entry) => entry.name === environment)?.nodeEnvironment ===
        'production';
      return {
        environment,
        secret: Boolean(secretKey),
        webhook: has(environment, 'STRIPE_WEBHOOK_SECRET'),
        publishable: has(environment, 'STRIPE_PUBLISHABLE_KEY'),
        // The backend refuses to start production on anything but a live-mode key.
        testKeyInProduction: production && secretKey !== '' && !secretKey.startsWith('sk_live_'),
      };
    });
    const complete = stripeKeys.every(
      (entry) => entry.secret && entry.webhook && entry.publishable && !entry.testKeyInProduction,
    );
    steps.push({
      title: 'Stripe — keys and the billing webhook for each environment',
      status: complete ? 'manual' : 'todo',
      lines: [
        ...stripeKeys.map(
          (entry) =>
            `${mark(entry.secret && !entry.testKeyInProduction)} ${entry.environment}: STRIPE_SECRET_KEY${entry.testKeyInProduction ? ' (not a live key — production needs sk_live_)' : ''} · ${mark(entry.webhook)} STRIPE_WEBHOOK_SECRET · ${mark(entry.publishable)} STRIPE_PUBLISHABLE_KEY (→ frontend VITE_STRIPE_PUBLISHABLE_KEY)`,
        ),
        "Stripe Workbench → Webhooks → Create an event destination (sandbox for development, live for production; API version = the backend's STRIPE_API_VERSION), then Reveal secret:",
        ...environments.map(
          (environment) =>
            `  ${environment}: ${backendOriginForEnvironment(config, environment) || '<api>'}${STRIPE_WEBHOOK_PATH}`,
        ),
        `  events: ${STRIPE_WEBHOOK_EVENTS.join(', ')}`,
        'Put them in .setup/.setup-credentials as STRIPE_*__<environment>, then: SETUP_INFRA_PROVIDERS=stripe pnpm setup:infra --yes',
      ],
    });
  }

  // 5. GitHub Environments — each app's own sync pushes its .env.<env>.
  const backendRepository = config.providers.github.repository;
  const frontend = frontendRepository(config);
  const repositories = [backendRepository, ...(frontend ? [frontend] : [])];
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
      ...(frontend ? [`cd ${options.frontendPath ?? '../<frontend>'} && pnpm github:sync`] : []),
      ...synced.map((entry) => `${mark(entry.ok)} ${entry.label} has secrets`),
      ...(synced.some((entry) => entry.ok === undefined)
        ? ['? = could not check — the GitHub login needs read access to environment secrets']
        : []),
    ],
  });

  // 6. Artifact attestations on a private repository.
  const privateRepositories = (
    await Promise.all(
      repositories.map(async (repository) => ({
        repository,
        isPrivate: await checks.repositoryIsPrivate(repository),
      })),
    )
  ).filter((entry) => entry.isPrivate === true);
  if (privateRepositories.length > 0) {
    steps.push({
      title: 'Artifact attestations on private repositories',
      status: 'manual',
      lines: [
        'GitHub stores attestations for a private repository only on GitHub Enterprise Cloud; on other',
        "plans the apps' attest steps fail the build. `pnpm setup:infra:deploy` sets",
        "ARTIFACT_ATTESTATIONS=disabled where the plan can't store them (the steps then skip with a warning):",
        ...privateRepositories.map((entry) => `  ${entry.repository}`),
      ],
    });
  }

  // 7–8. Deploy.
  steps.push({
    title: 'First deploy — merge to main in each app',
    status: 'manual',
    lines: [
      'Backend: post-merge CI → image → Railway development (migrate → seed → API → worker).',
      'Frontend: post-merge CI → Netlify development alias.',
      'A failed post-merge run: `pnpm setup:infra:deploy` re-runs its failed jobs.',
    ],
  });
  steps.push({
    title: "Go live — merge each app's Release PR, then deploy it from main",
    status: 'manual',
    lines: [
      'Merging the release-please Release PR creates the release tag. Production accepts protected',
      'branches only, so the release does not deploy by itself:',
      "  pnpm setup:infra:deploy --production   (release-deploy.yml from main with each app's latest tag)",
    ],
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
export async function runNextSteps(config: SetupConfig): Promise<void> {
  const dnsRecords = saveDnsRequirements(collectedDnsRequirements(), config.product?.domain);
  const steps = await buildNextSteps({
    config,
    dnsRecords,
    checks: liveChecks(),
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
