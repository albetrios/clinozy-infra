/**
 * `pnpm setup:infra:plan` — a read-only diff of what exists vs what will be created or
 * updated, before any apply (our own plan/apply implementation):
 *
 *   CREATE     — resource is absent → apply will create it
 *   UP-TO-DATE — resource present in state, no changes
 *   UPDATE     — present but config drifted → apply will update it (lists changes)
 *   VALIDATE   — validate-only provider (verifies a credential each run; creates nothing)
 *   DISABLED   — turned off in setup.config.json or missing its secret
 *
 * No mutations, no network writes. Drives the same `detectStatus()` the guided apply uses,
 * so the plan and the apply agree.
 */
import { getEnvironmentNames, loadConfig } from '@setup/common/config.js';
import * as logger from '@setup/common/logger.js';
import { loadSecrets } from '@setup/common/secrets.js';
import { loadState } from '@setup/common/state.js';
import {
  summarizeOutcomes,
  type ResourceStatus,
  type StepOutcome,
} from '@setup/common/interactive-step.js';
import type {
  InfraProvider,
  InfraProviderContext,
  InfraProviderDescription,
  SetupState,
} from '@setup/common/types.js';
import { PRESETS } from '@setup/presets/index.js';
import { printDoctorSummary, runDoctorChecks } from './doctor.js';
import {
  buildProviderContext,
  selectProviders,
  type ProviderSelectionInput,
} from './orchestrator.js';

type PlanAction = 'CREATE' | 'UP-TO-DATE' | 'UPDATE' | 'VALIDATE' | 'DISABLED';

interface PlanRow {
  action: PlanAction;
  provider: string;
  organization: string;
  project: string;
  environments: string;
  services: string;
  changes: string[];
}

function actionFor(status: ResourceStatus): PlanAction {
  if (status.state === 'absent') return 'CREATE';
  if (status.state === 'drift') return 'UPDATE';
  return 'UP-TO-DATE';
}

// When several providers share a planGroup, the row keeps the most "active" action.
const ACTION_PRECEDENCE: PlanAction[] = ['CREATE', 'UPDATE', 'VALIDATE', 'UP-TO-DATE', 'DISABLED'];

function mergeCell(a: string, b: string): string {
  const parts = [...a.split(', '), ...b.split(', ')].filter((part) => part && part !== '—');
  return parts.length > 0 ? [...new Set(parts)].join(', ') : '—';
}

/** Collapse rows that share a `group` into one (used for Railway server + Redis). */
function mergeByGroup(rows: Array<PlanRow & { group: string }>): PlanRow[] {
  const merged = new Map<string, PlanRow & { group: string }>();
  for (const row of rows) {
    const existing = merged.get(row.group);
    if (!existing) {
      merged.set(row.group, { ...row, provider: row.group });
      continue;
    }
    existing.action =
      ACTION_PRECEDENCE.find((a) => a === existing.action || a === row.action) ?? existing.action;
    existing.organization =
      existing.organization !== '—' ? existing.organization : row.organization;
    existing.project = existing.project !== '—' ? existing.project : row.project;
    existing.environments = mergeCell(existing.environments, row.environments);
    existing.services = mergeCell(existing.services, row.services);
    existing.changes = [...existing.changes, ...row.changes];
  }
  return [...merged.values()];
}

/** State-based action + drift changes (the fast, default path). */
async function stateResult(
  provider: InfraProvider,
  context: InfraProviderContext,
): Promise<{ action: PlanAction; changes: string[] }> {
  const step = provider.buildStep(context);
  if (!step.enabled) return { action: 'DISABLED', changes: [] };
  if (!step.detectStatus) return { action: 'VALIDATE', changes: [] };
  const status = await step.detectStatus();
  return { action: actionFor(status), changes: status.changes ?? [] };
}

/** Remote action + field-level drift via `inspectRemote`; degrades to state on error. */
async function remoteResult(
  provider: InfraProvider,
  context: InfraProviderContext,
): Promise<{ action: PlanAction; changes: string[] }> {
  const step = provider.buildStep(context);
  if (!step.enabled) return { action: 'DISABLED', changes: [] };
  if (!provider.inspectRemote) return stateResult(provider, context);
  const inspection = await provider.inspectRemote(context);
  if (inspection.error) {
    const fallback = await stateResult(provider, context);
    return { action: fallback.action, changes: [`remote: ${inspection.error}`] };
  }
  if (!inspection.present) return { action: 'CREATE', changes: [] };
  const drift = inspection.fields.filter((field) => !field.matches);
  if (drift.length === 0) return { action: 'UP-TO-DATE', changes: [] };
  return {
    action: 'UPDATE',
    changes: drift.map(
      (field) => `${field.label}: ${field.expected || '—'} → ${field.remote || '—'}`,
    ),
  };
}

const COLUMNS = [
  'ACTION',
  'PROVIDER',
  'ORGANIZATION',
  'PROJECT',
  'ENVIRONMENTS',
  'SERVICES',
] as const;

/**
 * Render the plan for a set of providers against an already-built context (read-only).
 * Shared by `runPlan` (the command) and the guided apply (so plan and apply agree).
 * Columns (organization/project/environments) come from each provider's `describe()`,
 * so the names match exactly what that provider's code uses (all from setup.config.json).
 */
export async function renderPlan(
  providers: readonly InfraProvider[],
  context: InfraProviderContext,
  remote = false,
): Promise<void> {
  const rawRows: Array<PlanRow & { group: string }> = [];
  for (const provider of providers) {
    const description = provider.describe?.(context) ?? {};
    const { action, changes } = remote
      ? await remoteResult(provider, context)
      : await stateResult(provider, context);
    rawRows.push({
      action,
      provider: provider.name,
      group: description.planGroup ?? provider.name,
      organization: description.organization ?? '—',
      project: description.project ?? '—',
      environments: description.environments?.join(', ') ?? '—',
      services: description.services?.join(', ') ?? '—',
      changes,
    });
  }

  // Collapse grouped providers (e.g. Railway server + Redis) into a single row.
  const rows = mergeByGroup(rawRows);

  const cells = (row: PlanRow): string[] => [
    row.action,
    row.provider,
    row.organization,
    row.project,
    row.environments,
    row.services,
  ];
  const widths = COLUMNS.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => cells(row)[index]?.length ?? 0)),
  );
  const line = (values: readonly string[]): string =>
    `  ${values.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ')}`;

  // Pre-formatted, column-aligned rows — use the non-wrapping printer so wide tables keep alignment.
  logger.infoRaw(line(COLUMNS));
  logger.infoRaw(line(widths.map((width) => '─'.repeat(width))));
  for (const row of rows) {
    logger.infoRaw(line(cells(row)));
    for (const change of row.changes)
      logger.infoRaw(`  ${' '.repeat(widths[0] ?? 0)}  • ${change}`);
  }

  const count = (action: PlanAction) => rows.filter((row) => row.action === action).length;
  logger.blank();
  logger.info(
    `Plan: ${count('CREATE')} to create, ${count('UPDATE')} to update, ${count('UP-TO-DATE')} up-to-date, ` +
      `${count('VALIDATE')} to validate, ${count('DISABLED')} disabled.`,
  );
}

/**
 * Final "what was provisioned" table, split PER ENVIRONMENT — one section per configured
 * environment (plus a "Shared" section for account/repo-scoped providers), each listing the
 * providers active there with their organization / project / services (from `describe()`).
 *
 * Fully driven by `context.environments` (= `config.environments`): adding an environment to
 * setup.config.json automatically adds a section here — and the same list drives provisioning, so
 * the new environment is created on the next apply with no code change.
 */
/**
 * The concrete resource(s) a provider created/recorded in run state, for one environment (or
 * account-scoped when `environmentName` is omitted). Sourced from `state` — the same place the
 * "Provisioned Resources" summary reads. Returns `—` when nothing is recorded (e.g. validate-only
 * providers, or ones whose output lives only in `.env.<environment>`).
 */
function createdResourcesFor(
  state: SetupState,
  providerKey: string,
  environmentName?: string,
): string {
  switch (providerKey) {
    case 'neon': {
      const project = environmentName ? state.neon?.projects?.[environmentName] : undefined;
      return project?.projectId ? `project ${project.projectName} (${project.projectId})` : '—';
    }
    case 'aws': {
      if (!environmentName) return '—';
      const bucket = state.aws?.buckets?.[environmentName]?.name;
      const user = state.aws?.iamUsers?.[environmentName]?.username;
      const parts = [bucket && `bucket ${bucket}`, user && `iam ${user}`].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : '—';
    }
    case 'railway-redis': {
      const database = environmentName ? state.redis?.databases?.[environmentName] : undefined;
      return database ? `redis ${database.databaseId}` : '—';
    }
    case 'railway': {
      const environment = environmentName
        ? state.railway?.environments?.[environmentName]
        : undefined;
      return environment ? `env ${environment.environmentId}` : '—';
    }
    case 'sentry':
      return state.sentry?.projectSlug ? `project ${state.sentry.projectSlug}` : '—';
    case 'jwt':
      return environmentName && state.jwt?.[environmentName] ? 'JWT keys' : '—';
    case 'posthog': {
      const perEnv = environmentName ? state.posthog?.projectApiKeys?.[environmentName] : undefined;
      const anyKey =
        perEnv ??
        state.posthog?.projectApiKey ??
        (state.posthog?.projectApiKeys && Object.keys(state.posthog.projectApiKeys).length > 0
          ? 'set'
          : undefined);
      return anyKey ? 'project key' : '—';
    }
    case 'github':
      return environmentName ? `GitHub Environment "${environmentName}"` : '—';
    case 'postman': {
      const collection = environmentName
        ? state.postman?.collections?.[environmentName]
        : undefined;
      return collection
        ? `collection ${collection}`
        : state.postman?.workspaceId
          ? 'workspace'
          : '—';
    }
    case 'scalar': {
      const scalarEnv = environmentName ? state.scalar?.environments?.[environmentName] : undefined;
      return scalarEnv?.registryUrl ?? (scalarEnv?.slug ? `slug ${scalarEnv.slug}` : '—');
    }
    default:
      // turnstile / oauth providers write their output to .env.<environment>, not state.
      return '—';
  }
}

/** Map a run-outcome token to a friendly provisioned-detail label. */
const OUTCOME_STATUS_LABEL: Record<string, string> = {
  OK: 'created',
  FAIL: 'failed',
  SKIP: 'skipped',
  ABORT: 'aborted',
  OFF: 'disabled',
};

export function renderProvisionedDetail(
  providers: readonly InfraProvider[],
  context: InfraProviderContext,
  outcomes: readonly StepOutcome<unknown>[] = [],
): void {
  const { state } = context;

  // Outcome per step ("<provider> · <env>" → OK/FAIL/SKIP/…), so every row is marked created/failed.
  const statusByStep = new Map(
    summarizeOutcomes([...outcomes]).rows.map((row) => [row.env, row.status]),
  );
  const statusFor = (providerName: string, environmentName?: string): string => {
    const lookup = (environment: string): string | undefined =>
      statusByStep.get(`${providerName} · ${environment}`);
    let token: string | undefined;
    if (environmentName) {
      token = lookup(environmentName);
    } else {
      // Account-scoped provider ran per environment — surface the worst outcome across them.
      const tokens = context.environments
        .map(lookup)
        .filter((value): value is string => Boolean(value));
      token =
        ['FAIL', 'ABORT', 'SKIP', 'OFF', 'OK'].find((value) => tokens.includes(value)) ?? tokens[0];
    }
    return token ? (OUTCOME_STATUS_LABEL[token] ?? token.toLowerCase()) : '—';
  };

  const described = providers
    .filter((provider) => provider.isEnabled(context))
    .map((provider) => ({ provider, description: provider.describe?.(context) ?? {} }));

  const toDetail = (
    entry: { provider: InfraProvider; description: InfraProviderDescription },
    environmentName?: string,
  ): logger.ProvisionedDetailRow => ({
    provider: entry.provider.name,
    status: statusFor(entry.provider.name, environmentName),
    organization: entry.description.organization ?? '—',
    project: entry.description.project ?? '—',
    services: entry.description.services?.join(', ') ?? '—',
    created: createdResourcesFor(state, entry.provider.key, environmentName),
  });

  const sections: Array<{ title: string; rows: logger.ProvisionedDetailRow[] }> = [];
  // One section per configured environment — auto-extends when you add an environment.
  for (const environmentName of context.environments) {
    const rows = described
      .filter((entry) => (entry.description.environments ?? []).includes(environmentName))
      .map((entry) => toDetail(entry, environmentName));
    sections.push({ title: environmentName, rows });
  }
  // Account / repo-scoped providers that aren't per-environment (Postman, Scalar, Resend, …).
  const sharedRows = described
    .filter(
      (entry) => !(entry.description.environments && entry.description.environments.length > 0),
    )
    .map((entry) => toDetail(entry));
  sections.push({ title: 'Shared (account / repo-scoped)', rows: sharedRows });

  logger.provisionedDetailTable(sections);
}

/** `pnpm setup:infra:plan` entrypoint — build the context, render the plan, print footer. */
export async function runPlan(
  options: { providerSelection?: ProviderSelectionInput; remote?: boolean } = {},
): Promise<void> {
  const config = loadConfig();
  const environments = getEnvironmentNames(config);
  const context = buildProviderContext(config, loadSecrets(config), loadState(), environments);
  const source = options.remote ? 'live remote' : 'local state';

  // Doctor first — surface config footguns before showing the plan.
  printDoctorSummary(runDoctorChecks(config, PRESETS));
  logger.blank();

  logger.info(
    `Plan (${source}) — ${config.project.displayName} (${config.project.name}) · ${environments.join(', ')}`,
  );
  logger.blank();
  await renderPlan(selectProviders(options.providerSelection), context, options.remote ?? false);
  logger.info(
    'Read-only — nothing was changed. Run `pnpm setup:infra` to apply (step-wise, guided).',
  );
}
