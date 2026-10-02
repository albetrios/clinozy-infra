/**
 * Interactive + scriptable Railway custom-domain helper.
 *
 * What it does (per environment + service):
 *   1. Resolve the Railway service (only services exposing inbound HTTP — `worker` is rejected).
 *   2. Ensure a Railway-generated service domain exists so the service has a backing hostname.
 *   3. Attach the requested custom domain (idempotent — adopts an existing attachment if present).
 *   4. Print the DNS records Railway expects at the user's DNS provider.
 *   5. Poll local DNS resolution and Railway's `customDomains.status` until both DNS is verified
 *      and Railway has issued the Let's Encrypt certificate (or the timeout elapses).
 *   6. Record `customDomain` on the in-memory run state (state is ephemeral — not persisted).
 *   7. Print the env-var follow-ups the user almost always needs (the API origin in
 *      `app.frontendUrl.<env>`, the frontend's `VITE_API_BASE_URL`) with a copy-pasteable
 *      `gh secret set` command. `FRONTEND_URL`, `ALLOWED_ORIGINS` and `OAUTH_*_REDIRECT_URI` are
 *      called out as unchanged — they follow the SPA origin, not the API domain.
 *
 * Modes:
 *   - Interactive (no flags): one-env-at-a-time, prompts walk through environment, service,
 *     target port, custom domain, confirmation.
 *   - Scriptable / non-interactive (flags below): same flow, no prompts. Suitable for CI or
 *     for batch-attaching across both `development` and `production`.
 *   - `--check`: read-only re-poll of an already-attached custom domain. Safe to run on a cron.
 *
 * Flags:
 *   --environment <name>          Repeatable. Limits the run to specific envs (resolved from
 *                                 live remote). When omitted, behavior depends on
 *                                 `--all-environments` and whether prompts are usable.
 *   --all-environments            Loop every environment found remotely for the project.
 *   --service <name>              Defaults to `api`. `worker` is rejected.
 *   --domain <fqdn>               Required (per env) when running non-interactively. Mutually
 *                                 exclusive with `--domain-template`.
 *   --domain-template <pattern>   Pattern with `{env}` placeholder, e.g.
 *                                 `api.{env}.example.com`. Convenient with
 *                                 `--all-environments`. Empty `{env}` segments collapse so
 *                                 `production` does not gain an `api..example.com` style label —
 *                                 see resolveDomainFromTemplate below.
 *   --port <n>                    Defaults to `app.port` from `tooling/setup/setup.config.json`
 *                                 (currently 3000).
 *   --check                       Read-only — query and print existing custom-domain status,
 *                                 don't create anything.
 *   --no-wait                     Skip the DNS + cert poll loop. Fire-and-forget.
 *   --wait-timeout-seconds <n>    How long to poll before giving up (default 900 = 15m).
 *   --poll-interval-seconds <n>   Cadence between polls (default 10s).
 *   --help, -h                    Print this flag reference.
 *
 * Run via: pnpm setup:domain
 */
import { promises as dns } from 'node:dns';
import { createInterface } from 'node:readline';
import * as logger from '@setup/common/logger.js';
import { loadConfig } from '@setup/common/config.js';
import { loadEnvSetupIntoProcess } from '@setup/common/secrets.js';
import { saveState } from '@setup/common/state.js';
import { hydrateStateFromRemote } from '@setup/infra/orchestrator.js';
import type { SetupState } from '@setup/common/types.js';
import { type DownstreamHintInput, downstreamEnvHints } from './custom-domain-hints.js';
import { ensureServiceDomain, railwayGraphQL } from './railway-api.js';

// Railway certificate-status enum values that mean "ready". Treated case-insensitively.
const READY_CERTIFICATE_STATUSES = new Set(['ISSUED', 'ACTIVE', 'ISSUE_SUCCESS']);

// Railway certificate-status enum values that mean "terminal failure".
const FAILED_CERTIFICATE_STATUSES = new Set([
  'FAILED',
  'ERROR',
  'ISSUE_FAILED',
  'VALIDATION_FAILED',
]);

const DEFAULT_WAIT_TIMEOUT_SECONDS = 900;
const DEFAULT_POLL_INTERVAL_SECONDS = 10;

interface DnsRecord {
  recordType: string;
  hostlabel: string;
  fqdn: string;
  requiredValue: string;
  currentValue: string;
  status: string;
  purpose: string;
  zone: string;
}

interface CustomDomainStatus {
  certificateStatus: string;
  verified: boolean;
  dnsRecords: DnsRecord[];
}

interface CustomDomainSummary {
  id: string;
  domain: string;
  targetPort: number | null;
  status: CustomDomainStatus;
}

async function fetchCustomDomains(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
): Promise<CustomDomainSummary[]> {
  const result = await railwayGraphQL<{
    domains: { customDomains: CustomDomainSummary[] };
  }>(
    token,
    `
    query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
        customDomains {
          id
          domain
          targetPort
          status {
            certificateStatus
            verified
            dnsRecords {
              recordType
              hostlabel
              fqdn
              requiredValue
              currentValue
              status
              purpose
              zone
            }
          }
        }
      }
    }
  `,
    { projectId, environmentId, serviceId },
  );
  return result.domains.customDomains;
}

async function createCustomDomain(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  domain: string,
  targetPort: number | undefined,
): Promise<CustomDomainSummary> {
  const result = await railwayGraphQL<{ customDomainCreate: CustomDomainSummary }>(
    token,
    `
    mutation($input: CustomDomainCreateInput!) {
      customDomainCreate(input: $input) {
        id
        domain
        targetPort
        status {
          certificateStatus
          verified
          dnsRecords {
            recordType
            hostlabel
            fqdn
            requiredValue
            currentValue
            status
            purpose
            zone
          }
        }
      }
    }
  `,
    {
      input: {
        projectId,
        environmentId,
        serviceId,
        domain,
        ...(typeof targetPort === 'number' ? { targetPort } : {}),
      },
    },
  );
  return result.customDomainCreate;
}

interface PromptChoice {
  label: string;
  value: string;
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePromise) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    readline.question(`  ${question}${suffix}: `, (answer) => {
      readline.close();
      const trimmed = answer.trim();
      resolvePromise(trimmed === '' && defaultValue !== undefined ? defaultValue : trimmed);
    });
  });
}

async function selectOne(
  question: string,
  choices: PromptChoice[],
  defaultIndex = 0,
): Promise<string> {
  const [first] = choices;
  if (!first) {
    throw new Error(`No choices available for "${question}"`);
  }
  if (choices.length === 1) {
    logger.info(`  ${question}: ${first.label} (only option)`);
    return first.value;
  }

  logger.info(question);
  for (const [index, choice] of choices.entries()) {
    logger.info(`    ${index + 1}) ${choice.label}`);
  }

  while (true) {
    const answer = await ask('Pick number', String(defaultIndex + 1));
    const index = Number.parseInt(answer, 10) - 1;
    const choice = choices[index];
    if (choice && Number.isInteger(index) && index >= 0 && index < choices.length) {
      return choice.value;
    }
    logger.warn(`  Invalid choice. Enter a number between 1 and ${choices.length}.`);
  }
}

function parsePort(input: string, source: string): number {
  const port = Number.parseInt(input, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port from ${source}: "${input}" (expected integer 1-65535)`);
  }
  return port;
}

function isValidDomain(domain: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain);
}

function isReadyCertificateStatus(status: string): boolean {
  return READY_CERTIFICATE_STATUSES.has(status.toUpperCase());
}

function isFailedCertificateStatus(status: string): boolean {
  return FAILED_CERTIFICATE_STATUSES.has(status.toUpperCase());
}

/**
 * Expand a domain template like `api.{env}.example.com`.
 * Replaces `{env}` with the env name. When the env is the default
 * environment (e.g. `production`) and the result would yield an
 * unnecessary label like `api.production.example.com`, the caller
 * can decide what they want — this helper does the literal substitution
 * only. For collapsing logic, prefer passing `--domain` explicitly.
 */
function resolveDomainFromTemplate(template: string, environmentName: string): string {
  return template.replaceAll('{env}', environmentName).toLowerCase();
}

function printDnsRecords(domain: string, status: CustomDomainStatus): void {
  logger.blank();
  logger.info(`DNS records to add at your DNS provider for ${domain}:`);
  if (status.dnsRecords.length === 0) {
    logger.warn('  Railway returned no DNS records yet — check the Railway dashboard.');
    return;
  }
  for (const record of status.dnsRecords) {
    logger.info(`  Type:     ${record.recordType}`);
    logger.info(`  Host:     ${record.hostlabel || '@'}`);
    logger.info(`  Value:    ${record.requiredValue}`);
    logger.info(`  Zone:     ${record.zone}`);
    logger.info(`  FQDN:     ${record.fqdn}`);
    logger.info(`  Status:   ${record.status} (current: ${record.currentValue || '-'})`);
    logger.info(`  Purpose:  ${record.purpose}`);
    logger.blank();
  }
  logger.info(
    `Certificate status: ${status.certificateStatus} (verified: ${status.verified ? 'yes' : 'no'})`,
  );
}

interface LocalDnsCheckResult {
  recordType: string;
  fqdn: string;
  expected: string;
  observed: string[];
  matches: boolean;
}

/**
 * Probe local DNS resolvers for each Railway-supplied record so the user gets
 * fast feedback before Railway's own re-verification kicks in. Returns a
 * per-record result; never throws — DNS failures are reflected in `observed`.
 */
async function probeLocalDns(records: DnsRecord[]): Promise<LocalDnsCheckResult[]> {
  const results: LocalDnsCheckResult[] = [];
  for (const record of records) {
    const expected = record.requiredValue;
    let observed: string[] = [];
    try {
      switch (record.recordType.toUpperCase()) {
        case 'CNAME':
        case 'ALIAS':
        case 'ANAME':
          observed = await dns.resolveCname(record.fqdn);
          break;
        case 'A':
          observed = await dns.resolve4(record.fqdn);
          break;
        case 'AAAA':
          observed = await dns.resolve6(record.fqdn);
          break;
        case 'TXT': {
          const txt = await dns.resolveTxt(record.fqdn);
          observed = txt.map((chunks) => chunks.join(''));
          break;
        }
        default:
          observed = [];
      }
    } catch {
      observed = [];
    }
    const matches = observed.some(
      (value) =>
        value.replace(/\.$/, '').toLowerCase() === expected.replace(/\.$/, '').toLowerCase(),
    );
    results.push({
      recordType: record.recordType,
      fqdn: record.fqdn,
      expected,
      observed,
      matches,
    });
  }
  return results;
}

function summarizeLocalDns(results: LocalDnsCheckResult[]): string {
  if (results.length === 0) return 'no records to probe';
  const matched = results.filter((result) => result.matches).length;
  return `local DNS ${matched}/${results.length} records resolve to expected values`;
}

async function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface PollOptions {
  waitTimeoutSeconds: number;
  pollIntervalSeconds: number;
}

type PollOutcome =
  | { ok: true; final: CustomDomainSummary }
  | { ok: false; reason: 'timeout' | 'cert-failed'; final: CustomDomainSummary };

async function pollUntilReady(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  customDomainId: string,
  options: PollOptions,
): Promise<PollOutcome> {
  const deadline = Date.now() + options.waitTimeoutSeconds * 1000;
  let lastSummary: CustomDomainSummary | null = null;

  while (Date.now() < deadline) {
    const customDomains = await fetchCustomDomains(token, projectId, environmentId, serviceId);
    const current = customDomains.find((entry) => entry.id === customDomainId);
    if (!current) {
      throw new Error(
        `Custom domain ${customDomainId} disappeared from Railway — was it deleted in the dashboard?`,
      );
    }
    lastSummary = current;

    const dnsResults = await probeLocalDns(current.status.dnsRecords);
    const timestamp = new Date().toISOString();
    logger.info(
      `[${timestamp}] verified=${current.status.verified} cert=${current.status.certificateStatus} (${summarizeLocalDns(dnsResults)})`,
    );

    if (current.status.verified && isReadyCertificateStatus(current.status.certificateStatus)) {
      return { ok: true, final: current };
    }
    if (isFailedCertificateStatus(current.status.certificateStatus)) {
      return { ok: false, reason: 'cert-failed', final: current };
    }

    await sleep(options.pollIntervalSeconds * 1000);
  }

  if (!lastSummary) {
    throw new Error('Poll loop ended before a single Railway status response was observed.');
  }
  return { ok: false, reason: 'timeout', final: lastSummary };
}

/**
 * Print the env-var follow-ups the user almost always needs after attaching a custom domain
 * (wording in ./custom-domain-hints.ts). We deliberately do not push any of these
 * automatically — keep that as a separate user decision.
 */
function printDownstreamEnvHints(input: DownstreamHintInput): void {
  logger.blank();
  for (const line of downstreamEnvHints(input)) {
    if (line === '') logger.blank();
    else logger.info(line);
  }
}

interface CliFlags {
  help: boolean;
  environments: string[];
  allEnvironments: boolean;
  service: string | null;
  domain: string | null;
  domainTemplate: string | null;
  port: number | null;
  check: boolean;
  noWait: boolean;
  waitTimeoutSeconds: number;
  pollIntervalSeconds: number;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    help: false,
    environments: [],
    allEnvironments: false,
    service: null,
    domain: null,
    domainTemplate: null,
    port: null,
    check: false,
    noWait: false,
    waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS,
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const consumeValue = (label: string): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${label}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--environment':
        flags.environments.push(consumeValue('--environment'));
        break;
      case '--all-environments':
        flags.allEnvironments = true;
        break;
      case '--service':
        flags.service = consumeValue('--service');
        break;
      case '--domain':
        flags.domain = consumeValue('--domain').toLowerCase();
        break;
      case '--domain-template':
        flags.domainTemplate = consumeValue('--domain-template');
        break;
      case '--port':
        flags.port = parsePort(consumeValue('--port'), '--port');
        break;
      case '--check':
        flags.check = true;
        break;
      case '--no-wait':
        flags.noWait = true;
        break;
      case '--wait-timeout-seconds':
        flags.waitTimeoutSeconds = parsePort(
          consumeValue('--wait-timeout-seconds'),
          '--wait-timeout-seconds',
        );
        break;
      case '--poll-interval-seconds':
        flags.pollIntervalSeconds = parsePort(
          consumeValue('--poll-interval-seconds'),
          '--poll-interval-seconds',
        );
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (flags.domain && flags.domainTemplate) {
    throw new Error('Pass either --domain or --domain-template, not both.');
  }

  return flags;
}

function printHelp(): void {
  const lines = [
    'pnpm setup:domain — attach a custom domain (with SSL) to a Railway service.',
    '',
    'Usage:',
    '  pnpm setup:domain                                       # interactive, single env',
    '  pnpm setup:domain --check --all-environments            # read-only status poll',
    '  pnpm setup:domain --all-environments \\',
    '                    --domain-template "api.{env}.example.com"',
    '  pnpm setup:domain --environment production --domain api.example.com',
    '',
    'Flags:',
    '  --environment <name>          Repeatable. Limit run to specific envs.',
    '  --all-environments            Loop every env found remotely for the project.',
    '  --service <name>              Defaults to "api". "worker" is rejected.',
    '  --domain <fqdn>               Required per env when running non-interactively.',
    '  --domain-template <pattern>   Use with --all-environments. {env} placeholder.',
    `  --port <n>                    Defaults to app.port from setup.config.json.`,
    '  --check                       Read-only; print status only, no mutations.',
    '  --no-wait                     Skip DNS + cert poll. Fire-and-forget.',
    `  --wait-timeout-seconds <n>    Default ${DEFAULT_WAIT_TIMEOUT_SECONDS}.`,
    `  --poll-interval-seconds <n>   Default ${DEFAULT_POLL_INTERVAL_SECONDS}.`,
    '  --help, -h                    Print this reference.',
    '',
    'Runbook: docs/deployment/runbooks/railway-custom-domain.md',
  ];
  for (const line of lines) {
    console.log(line);
  }
}

interface EnvironmentBinding {
  name: string;
  environmentId: string;
  services: Record<string, { serviceId: string }>;
}

function listEnvironments(state: SetupState): EnvironmentBinding[] {
  const entries = Object.entries(state.railway?.environments ?? {});
  return entries.map(([name, value]) => ({
    name,
    environmentId: value.environmentId,
    services: Object.fromEntries(
      Object.entries(value.services).map(([serviceName, service]) => [
        serviceName,
        { serviceId: service.serviceId },
      ]),
    ),
  }));
}

async function resolveEnvironmentSelection(
  flags: CliFlags,
  available: EnvironmentBinding[],
): Promise<EnvironmentBinding[]> {
  if (flags.allEnvironments) {
    return available;
  }
  if (flags.environments.length > 0) {
    const byName = new Map(available.map((entry) => [entry.name, entry]));
    const selected: EnvironmentBinding[] = [];
    for (const requested of flags.environments) {
      const match = byName.get(requested);
      if (!match) {
        throw new Error(
          `Environment "${requested}" not found remotely for this Railway project. Available: ${available
            .map((entry) => entry.name)
            .join(', ')}`,
        );
      }
      selected.push(match);
    }
    return selected;
  }
  const chosen = await selectOne(
    'Pick the Railway environment',
    available.map((entry) => ({
      label: `${entry.name} (${entry.environmentId})`,
      value: entry.name,
    })),
  );
  return [available.find((entry) => entry.name === chosen) as EnvironmentBinding];
}

async function resolveService(
  flags: CliFlags,
  environment: EnvironmentBinding,
): Promise<{ name: string; serviceId: string }> {
  const eligibleServices = Object.entries(environment.services).filter(
    ([name]) => name.toLowerCase() !== 'worker',
  );
  if (eligibleServices.length === 0) {
    throw new Error(
      `Environment "${environment.name}" has no HTTP-exposing services (workers are not eligible for custom domains).`,
    );
  }

  const [firstService] = eligibleServices;
  const requestedName =
    flags.service ?? (eligibleServices.length === 1 && firstService ? firstService[0] : null);

  if (requestedName) {
    if (requestedName.toLowerCase() === 'worker') {
      throw new Error(
        '`worker` services have no inbound HTTP and cannot have a custom domain. Pick the `api` service.',
      );
    }
    const match = eligibleServices.find(([name]) => name === requestedName);
    if (!match) {
      throw new Error(
        `Service "${requestedName}" not found in environment "${environment.name}". Eligible: ${eligibleServices
          .map(([name]) => name)
          .join(', ')}`,
      );
    }
    return { name: match[0], serviceId: match[1].serviceId };
  }

  const chosen = await selectOne(
    'Pick the service',
    eligibleServices.map(([name, value]) => ({
      label: `${name} (${value.serviceId})`,
      value: name,
    })),
  );
  const match = eligibleServices.find(([name]) => name === chosen);
  if (!match) {
    throw new Error(`Service "${chosen}" not found after selection.`);
  }
  return { name: match[0], serviceId: match[1].serviceId };
}

async function resolveDomain(
  flags: CliFlags,
  environmentName: string,
  isInteractiveDefault: boolean,
): Promise<string | null> {
  if (flags.domain) return flags.domain;
  if (flags.domainTemplate) return resolveDomainFromTemplate(flags.domainTemplate, environmentName);
  if (flags.check) return null;
  if (!isInteractiveDefault) {
    throw new Error(
      `--domain or --domain-template is required when running non-interactively (env: ${environmentName}).`,
    );
  }
  const input = (await ask('  Custom domain (e.g. api.example.com)')).toLowerCase();
  return input;
}

function resolveTargetPort(flags: CliFlags, defaultPort: number): number {
  return flags.port ?? defaultPort;
}

function persistCustomDomainIntoState(
  state: SetupState,
  environmentName: string,
  serviceName: string,
  customDomain: CustomDomainSummary,
  targetPort: number | undefined,
): void {
  const railway = state.railway;
  if (!railway?.environments) return;
  const environment = railway.environments[environmentName];
  if (!environment) return;
  const service = environment.services[serviceName];
  if (!service) return;

  service.customDomain = {
    domain: customDomain.domain,
    customDomainId: customDomain.id,
    ...(typeof targetPort === 'number' ? { targetPort } : {}),
    verified: customDomain.status.verified,
    certificateStatus: customDomain.status.certificateStatus,
    attachedAt: new Date().toISOString(),
  };
}

interface RunOneInput {
  token: string;
  projectId: string;
  environment: EnvironmentBinding;
  service: { name: string; serviceId: string };
  domain: string | null;
  targetPort: number;
  flags: CliFlags;
  state: SetupState;
  oauthGoogleEnabled: boolean;
  oauthGithubEnabled: boolean;
}

interface RunOneOutput {
  status: 'ok' | 'pending' | 'failed' | 'skipped';
  message: string;
}

async function runOne(input: RunOneInput): Promise<RunOneOutput> {
  const {
    token,
    projectId,
    environment,
    service,
    domain,
    targetPort,
    flags,
    state,
    oauthGoogleEnabled,
    oauthGithubEnabled,
  } = input;

  if (flags.check) {
    const customDomains = await fetchCustomDomains(
      token,
      projectId,
      environment.environmentId,
      service.serviceId,
    );
    if (customDomains.length === 0) {
      logger.warn(
        `[${environment.name}/${service.name}] no custom domains attached. Re-run without --check to add one.`,
      );
      return { status: 'skipped', message: 'no custom domain attached' };
    }
    for (const summary of customDomains) {
      logger.info(`[${environment.name}/${service.name}] ${summary.domain}`);
      printDnsRecords(summary.domain, summary.status);
      const localDns = await probeLocalDns(summary.status.dnsRecords);
      logger.info(`  ${summarizeLocalDns(localDns)}`);
    }
    return { status: 'ok', message: 'check complete' };
  }

  if (!domain) {
    throw new Error(
      `No --domain or --domain-template provided for ${environment.name}/${service.name}.`,
    );
  }
  if (!isValidDomain(domain)) {
    throw new Error(`Invalid domain: "${domain}"`);
  }

  logger.info(`[${environment.name}/${service.name}] attaching ${domain} (port ${targetPort})...`);

  const { domain: serviceDomain, created } = await ensureServiceDomain(token, {
    projectId,
    environmentId: environment.environmentId,
    serviceId: service.serviceId,
    targetPort,
  });
  if (created) logger.success(`  Service domain created: ${serviceDomain.domain}`);
  else logger.info(`  Service domain already exists: ${serviceDomain.domain}`);

  const existingCustomDomains = await fetchCustomDomains(
    token,
    projectId,
    environment.environmentId,
    service.serviceId,
  );
  let customDomain = existingCustomDomains.find((entry) => entry.domain.toLowerCase() === domain);
  if (customDomain) {
    logger.info(`  Custom domain already attached: ${customDomain.domain}`);
  } else {
    logger.info(`  Attaching custom domain ${domain}...`);
    customDomain = await createCustomDomain(
      token,
      projectId,
      environment.environmentId,
      service.serviceId,
      domain,
      targetPort,
    );
    logger.success(`  Custom domain attached: ${customDomain.domain}`);
  }

  printDnsRecords(customDomain.domain, customDomain.status);

  let finalSummary = customDomain;
  if (!flags.noWait) {
    logger.blank();
    logger.info(
      `  Polling DNS verification + certificate issuance (timeout ${flags.waitTimeoutSeconds}s, interval ${flags.pollIntervalSeconds}s)...`,
    );
    const outcome = await pollUntilReady(
      token,
      projectId,
      environment.environmentId,
      service.serviceId,
      customDomain.id,
      {
        waitTimeoutSeconds: flags.waitTimeoutSeconds,
        pollIntervalSeconds: flags.pollIntervalSeconds,
      },
    );
    finalSummary = outcome.final;
    if (outcome.ok) {
      logger.success(
        `  Verified: ${finalSummary.domain} — certificate ${finalSummary.status.certificateStatus}`,
      );
    } else if (outcome.reason === 'cert-failed') {
      logger.error(
        `  Certificate issuance failed: ${finalSummary.status.certificateStatus}. Check DNS records and CAA settings.`,
      );
    } else {
      logger.warn(
        `  Timed out waiting for verification (last: verified=${finalSummary.status.verified}, cert=${finalSummary.status.certificateStatus}). Re-run with --check to resume polling.`,
      );
    }
  }

  persistCustomDomainIntoState(state, environment.name, service.name, finalSummary, targetPort);

  printDownstreamEnvHints({
    environmentName: environment.name,
    serviceName: service.name,
    domain: finalSummary.domain,
    oauthGoogleEnabled,
    oauthGithubEnabled,
  });

  if (flags.noWait) return { status: 'pending', message: 'attached, polling skipped' };
  if (
    finalSummary.status.verified &&
    isReadyCertificateStatus(finalSummary.status.certificateStatus)
  ) {
    return { status: 'ok', message: 'verified + cert issued' };
  }
  if (isFailedCertificateStatus(finalSummary.status.certificateStatus)) {
    return { status: 'failed', message: `cert ${finalSummary.status.certificateStatus}` };
  }
  return { status: 'pending', message: 'awaiting verification — re-run with --check' };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  loadEnvSetupIntoProcess();
  const token = (process.env.RAILWAY_TOKEN ?? '').trim();
  if (!token) {
    logger.error('RAILWAY_TOKEN is not set in .setup/.setup-credentials or process.env.');
    logger.info(
      'Get a token at https://railway.app/account/tokens and add it to .setup/.setup-credentials.',
    );
    process.exit(1);
  }

  const config = loadConfig();
  // State is ephemeral (no persisted file): hydrate the Railway project/environments from
  // live remote before reading them.
  const state = await hydrateStateFromRemote({
    providerSelection: { includeKeys: ['railway', 'railway-redis'] },
  });

  if (!state.railway?.projectId) {
    logger.error(
      'No Railway project found remotely for this config. Run pnpm setup:infra first to provision Railway.',
    );
    process.exit(1);
  }

  const projectId = state.railway.projectId;
  const available = listEnvironments(state);
  if (available.length === 0) {
    logger.error('No Railway environments found remotely. Run pnpm setup:infra to provision them.');
    process.exit(1);
  }

  const isInteractiveDefault =
    !flags.allEnvironments &&
    flags.environments.length === 0 &&
    !flags.domain &&
    !flags.domainTemplate &&
    !flags.check;

  logger.banner(
    config.project.displayName,
    available.map((entry) => entry.name),
  );

  const selectedEnvironments = await resolveEnvironmentSelection(flags, available);
  const defaultPort = config.app.port;
  const oauthGoogleEnabled = config.providers.oauth.google.enabled;
  const oauthGithubEnabled = config.providers.oauth.github.enabled;

  const summaryRows: Array<{ env: string; status: string; detail: string }> = [];

  for (const environment of selectedEnvironments) {
    logger.blank();
    logger.divider();
    logger.info(`Environment: ${environment.name} (${environment.environmentId})`);
    let resolvedService: { name: string; serviceId: string };
    try {
      resolvedService = await resolveService(flags, environment);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(message);
      summaryRows.push({ env: environment.name, status: 'ERROR', detail: message });
      continue;
    }

    const targetPort = resolveTargetPort(flags, defaultPort);
    let domain: string | null;
    try {
      domain = await resolveDomain(flags, environment.name, isInteractiveDefault);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(message);
      summaryRows.push({ env: environment.name, status: 'ERROR', detail: message });
      continue;
    }

    if (isInteractiveDefault && !flags.check) {
      logger.info(`  Target port: ${targetPort}`);
      logger.info(`  Custom domain: ${domain}`);
      const confirm = (await ask('  Proceed? (y/N)', 'N')).toLowerCase();
      if (!(confirm === 'y' || confirm === 'yes')) {
        logger.info(`Skipped ${environment.name}.`);
        summaryRows.push({ env: environment.name, status: 'SKIPPED', detail: 'user declined' });
        continue;
      }
    }

    try {
      const result = await runOne({
        token,
        projectId,
        environment,
        service: resolvedService,
        domain,
        targetPort,
        flags,
        state,
        oauthGoogleEnabled,
        oauthGithubEnabled,
      });
      summaryRows.push({
        env: environment.name,
        status:
          result.status === 'ok'
            ? 'OK'
            : result.status === 'pending'
              ? 'PENDING'
              : result.status === 'skipped'
                ? 'SKIPPED'
                : 'ERROR',
        detail: result.message,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(message);
      summaryRows.push({ env: environment.name, status: 'ERROR', detail: message });
    }
  }

  saveState(state);

  logger.blank();
  logger.divider();
  logger.table(summaryRows);
  logger.success('Done. Re-run with --check to resume any pending verification.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.blank();
  logger.error(message);
  process.exit(1);
});
