import { createInterface } from 'node:readline';
import * as logger from '@setup/common/logger.js';
import { runNextSteps } from './next-steps.js';
import { isAssumeYes } from '@setup/common/prompts.js';
import { loadConfig, getEnvironmentNames, getConfigPath } from '@setup/common/config.js';
import {
  loadSecrets,
  getSecretsPath,
  ensureEnvSetupTemplate,
  envSetupFileExists,
} from '@setup/common/secrets.js';
import { hasAnyEnvSecret } from '@setup/common/secrets.js';
import { loadState, saveState } from '@setup/common/state.js';
import { checkPrerequisites } from './prerequisites.js';
import { runGuide } from './guide.js';
import { exportEnvFiles } from '@setup/envs/export-env-files.js';
import { getInfraProviders } from './providers/index.js';
import { runStatusMatrix } from './status-matrix.js';
import {
  syncGithubFoundations,
  provision as githubProvision,
} from './providers/setup-github/setup-github.provider.js';
import {
  assertInteractive,
  runInteractiveStep,
  summarizeOutcomes,
  promptSetupEnvironmentPhase,
  usesEnvironmentFirstTraversal,
  type StepDescriptor,
  type StepOutcome,
} from '@setup/common/interactive-step.js';
import { SetupAbort, SetupError } from '@setup/common/setup-error.js';
import { renderPlan, renderProvisionedDetail } from './plan.js';
import {
  formatSetupServiceName,
  formatSetupServiceNames,
  reviewProjectIdentity,
  SETUP_SERVICE_NAMES,
} from './identity-review.js';
import type {
  SetupConfig,
  SetupSecrets,
  SetupState,
  InfraProviderContext,
  InfraProvider,
} from '@setup/common/types.js';

export interface ProvisionOptions {
  providerSelection?: ProviderSelectionInput;
}

export interface ProviderSelectionInput {
  includeKeys?: string[];
  skipKeys?: string[];
}

export function buildProviderContext(
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
  environments: string[],
): InfraProviderContext {
  return {
    config,
    secrets,
    state,
    environments,
    applyStateUpdates: (updates) => {
      Object.assign(state, updates);
      saveState(state);
    },
  };
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

const PROVIDER_ALLOW_LIST_ENV = 'SETUP_INFRA_PROVIDERS';
const PROVIDER_SKIP_LIST_ENV = 'SETUP_INFRA_SKIP_PROVIDERS';

export function getAvailableProviderKeys(): string[] {
  return getInfraProviders().map((provider) => provider.key);
}

function parseProviderKeyList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean);
}

function formatProviderKeys(keys: string[]): string {
  return keys.length > 0 ? keys.join(', ') : 'none';
}

function assertKnownProviderKeys(keys: string[]): void {
  const knownKeys = new Set(getAvailableProviderKeys());
  const unknownKeys = keys.filter((key) => !knownKeys.has(key));
  if (unknownKeys.length === 0) return;
  throw new Error(
    `Unknown setup:infra provider key(s): ${unknownKeys.join(', ')}. Available providers: ${getAvailableProviderKeys().join(', ')}`,
  );
}

export function selectProviders(input?: ProviderSelectionInput): readonly InfraProvider[] {
  const includeKeys =
    input?.includeKeys && input.includeKeys.length > 0
      ? input.includeKeys
      : parseProviderKeyList(process.env[PROVIDER_ALLOW_LIST_ENV]);
  const skipKeys =
    input?.skipKeys && input.skipKeys.length > 0
      ? input.skipKeys
      : parseProviderKeyList(process.env[PROVIDER_SKIP_LIST_ENV]);

  assertKnownProviderKeys(includeKeys);
  assertKnownProviderKeys(skipKeys);

  const includeSet = includeKeys.length > 0 ? new Set(includeKeys) : null;
  const skipSet = new Set(skipKeys);

  return getInfraProviders().filter((provider) => {
    if (includeSet && !includeSet.has(provider.key)) return false;
    return !skipSet.has(provider.key);
  });
}

function showProviderSelection(providers: readonly InfraProvider[]): void {
  logger.info(
    `Selected setup:infra providers: ${formatProviderKeys(providers.map((provider) => provider.key))}`,
  );
  logger.info(
    `Provider selection can also be passed through ${PROVIDER_ALLOW_LIST_ENV}=neon,jwt,github or ${PROVIDER_SKIP_LIST_ENV}=postman.`,
  );
}

function getEnvironmentBranchEntries(config: SetupConfig): logger.EnvironmentBranchEntry[] {
  return config.environments.map((environment) => ({
    name: environment.name,
    label: environment.label,
    branch: environment.deployBranch,
    services: SETUP_SERVICE_NAMES.map(formatSetupServiceName),
    ...(environment.isDefault !== undefined ? { isDefault: environment.isDefault } : {}),
  }));
}

function showHeader(config: SetupConfig, environments: string[]): void {
  logger.banner(config.project.displayName, environments);
  logger.environmentBranchMapping(getEnvironmentBranchEntries(config));
}

async function confirm(message: string): Promise<boolean> {
  if (isAssumeYes()) {
    logger.info(`  ${message} (y/N): y  [--yes]`);
    return true;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePromise) => {
    readline.question(`  ${message} (y/N): `, (answer) => {
      readline.close();
      resolvePromise(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/** The exact word the operator must type to pass the final provisioning gate. */
const FINAL_CONFIRMATION_WORD = 'provision';

/**
 * Word-match confirmation for a destructive action: the operator must type `word` exactly
 * (case-insensitive) — a bare "y" is NOT enough. Anything else aborts. `--yes` auto-passes.
 */
async function confirmWord(message: string, word: string): Promise<boolean> {
  if (isAssumeYes()) {
    logger.info(`  ${message} (type "${word}"): ${word}  [--yes]`);
    return true;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePromise) => {
    readline.question(
      `  ${message}\n  Type "${word}" to proceed (anything else aborts): `,
      (answer) => {
        readline.close();
        resolvePromise(answer.trim().toLowerCase() === word.toLowerCase());
      },
    );
  });
}

async function confirmBranchProceed(config: SetupConfig): Promise<boolean> {
  const entries = getEnvironmentBranchEntries(config);
  const summaryLine = entries
    .map((entry) => `${entry.branch} → ${entry.name} (${entry.services?.join(', ')})`)
    .join(', ');
  logger.info(
    `Setup will affect ${entries.length} branch${entries.length === 1 ? '' : 'es'} (1 branch = 1 environment; each environment gets api + worker): ${summaryLine}.`,
  );
  return confirm('Proceed with these branches/environments?');
}

async function doubleConfirm(): Promise<boolean> {
  const first = await confirm('Are these settings correct?');
  if (!first) return false;

  logger.blank();
  return confirmWord(
    'FINAL CONFIRMATION: this will create REAL resources.',
    FINAL_CONFIRMATION_WORD,
  );
}

// ─── SETTINGS REVIEW ────────────────────────────────────────────────────────

function displaySettingsReview(
  config: SetupConfig,
  context: InfraProviderContext,
  providers: readonly InfraProvider[],
): void {
  const resources: Array<{ provider: string; detail: string }> = [];
  const extras: Array<{ provider: string; detail: string }> = [];

  for (const provider of providers) {
    const entries = provider.settingsReview?.(context) ?? [];
    for (const entry of entries) {
      if (entry.bucket === 'resource') {
        resources.push({ provider: entry.provider, detail: entry.detail });
      } else {
        extras.push({ provider: entry.provider, detail: entry.detail });
      }
    }
  }

  logger.settingsReview(
    config.project.name,
    config.project.organization,
    getEnvironmentBranchEntries(config),
    resources,
    extras,
  );
}

// ─── PRE-EXISTENCE CHECK ────────────────────────────────────────────────────

async function checkForExistingResources(
  context: InfraProviderContext,
  providers: readonly InfraProvider[],
): Promise<Array<{ provider: string; detail: string }>> {
  const existing: Array<{ provider: string; detail: string }> = [];

  logger.info('Checking for existing resources...');
  logger.blank();

  for (const provider of providers) {
    if (!provider.detectExisting) continue;
    const found = await provider.detectExisting(context);
    existing.push(...found);
  }

  return existing;
}

// ─── POST-PROVISION ENV OUTPUT PROMPT ────────────────────────────────────────

function promptEnvOutput(environments: string[]): void {
  logger.blank();
  logger.divider();
  console.log('');
  console.log('  Provisioning complete. Values for', environments.length, 'environment(s) ready.');
  console.log('');
  console.log('  .env.<environment> files were created from .env.example and populated');
  console.log('  with provisioned values. If GitHub is enabled, they were also pushed');
  console.log('  to GitHub Environment secrets and variables.');
  console.log('');
  console.log('  Re-run pnpm setup:infra:export-env or pnpm setup:github at any time to refresh.');
}

// ─── PREVIEW ────────────────────────────────────────────────────────────────

export function runPreview(options: { providerSelection?: ProviderSelectionInput } = {}): void {
  const config = loadConfig();
  const environments = getEnvironmentNames(config);
  const secrets = loadSecrets(config);
  const state = loadState();
  const context = buildProviderContext(config, secrets, state, environments);
  const providers = selectProviders(options.providerSelection);

  showHeader(config, environments);
  showProviderSelection(providers);
  logger.blank();

  const configPath = getConfigPath();
  const secretsPath = getSecretsPath();

  // Preview is READ-ONLY — it must never write the credentials template (doing so
  // can scaffold an empty .setup/.setup-credentials that masks a real one). Only
  // inform the user how to create it. The apply path (runProvision) scaffolds it.
  if (!envSetupFileExists()) {
    logger.info(
      'No .setup/.setup-credentials yet — create it with `pnpm setup:infra:init`, or copy `.setup-credentials.example` to .setup/.setup-credentials, then fill the values.',
    );
  }

  const previewEntries: Array<{
    provider: string;
    detail: string;
    url: string;
    configKey: string;
  }> = [];
  for (const provider of providers) {
    const entry = provider.preview?.(context);
    if (!entry) continue;
    previewEntries.push({
      provider: provider.name,
      detail: entry.detail,
      url: entry.url,
      configKey: entry.configKey,
    });
  }

  logger.previewPlan(configPath, secretsPath, previewEntries);
}

// ─── PROVISION ──────────────────────────────────────────────────────────────

export async function runProvision(options: ProvisionOptions = {}): Promise<void> {
  assertInteractive();
  const config = await reviewProjectIdentity();
  const environments = getEnvironmentNames(config);
  const selectedProviders = selectProviders(options.providerSelection);

  showHeader(config, environments);
  showProviderSelection(selectedProviders);
  logger.blank();

  if (!(await confirmBranchProceed(config))) {
    throw new SetupAbort('Aborted. No resources were created.');
  }
  logger.blank();

  if (!checkPrerequisites(config, new Set(selectedProviders.map((provider) => provider.key)))) {
    throw new SetupError('Prerequisites not met.');
  }

  if (ensureEnvSetupTemplate(config)) {
    throw new SetupAbort(
      'Generated .setup/.setup-credentials template. Fill the values (see URLs in the file) and run pnpm setup:infra again.',
    );
  }

  // Decide which environments to set up ONCE — asked a single time here and honored by BOTH the
  // guide (key collection) and the provisioning phase, so the per-environment continue/skip/abort
  // question is never repeated. (Under --yes every environment is kept.)
  const environmentFirst = usesEnvironmentFirstTraversal(environments);
  let activeEnvironments = environments;
  if (environmentFirst) {
    logger.info(
      `Multiple environments — choose which to set up (asked once; applies to the whole run): ${environments.join(' → ')}.`,
    );
    const selectedEnvironments: string[] = [];
    for (const environmentName of environments) {
      const phaseDecision = await promptSetupEnvironmentPhase(environmentName);
      if (phaseDecision === 'abort') {
        throw new SetupAbort('Aborted. No resources were created.');
      }
      if (phaseDecision === 'skip') {
        logger.warn(`Skipping environment "${environmentName}".`);
        continue;
      }
      selectedEnvironments.push(environmentName);
    }
    activeEnvironments = selectedEnvironments;
  }

  await runGuide(config, activeEnvironments);

  const secrets = loadSecrets(config);
  const state = loadState();
  const context = buildProviderContext(config, secrets, state, environments);

  if (!hasAnyEnvSecret(environments)) {
    throw new SetupError(
      'No secrets found. Fill .setup/.setup-credentials with your API keys (each variable has a comment with the URL to get it).',
      { hint: 'Then run pnpm setup:infra again.' },
    );
  }

  displaySettingsReview(config, context, selectedProviders);

  // Show the plan (what will be created/updated) before asking to apply.
  logger.blank();
  await renderPlan(selectedProviders, context);
  logger.blank();

  if (!(await doubleConfirm())) {
    throw new SetupAbort('Aborted. No resources were created.');
  }

  logger.blank();

  // Pre-flight state reconstruction: for every enabled provider that supports
  // `detectRemote`, query the remote provider and persist any resources we
  // already created in a previous run that are missing from local state.
  // Without this, providers whose state was wiped (or never written) would
  // happily create duplicate resources (e.g. a second Railway Redis service)
  // on rerun because their `alreadyDone` / idempotency checks only consult
  // local state.
  logger.info('Reconstructing state from remote providers (pre-flight)...');
  const { foundCount: reconstructedCount, updatedProviderKeys } = await reconstructStateFromRemote({
    config,
    secrets,
    state,
    environments,
    providers: selectedProviders,
    verbose: false,
  });
  if (reconstructedCount > 0) {
    logger.success(
      `Adopted ${reconstructedCount} existing resource(s) from remote into state: ${updatedProviderKeys.join(', ')}.`,
    );
  } else {
    logger.info('No existing remote resources required adoption.');
  }
  logger.blank();

  const existingResources = await checkForExistingResources(context, selectedProviders);
  if (existingResources.length > 0) {
    logger.existingResourcesNotice(existingResources);
  } else {
    logger.success('No existing resources found — safe to proceed.');
  }

  logger.blank();

  const githubSyncEnabled =
    selectedProviders.some((provider) => provider.key === 'github') &&
    config.providers.github.syncEnvironments;
  // Per-environment step numbering: each environment runs its OWN 1..N sequence (N = provider
  // count for that env), so the header reads "Step 3/15 · development" — not a global 3/31. The
  // env-agnostic tail (export .env, optional GitHub Environments sync) runs in a short "Finalize"
  // sequence of its own.
  const outcomes: StepOutcome<unknown>[] = [];

  const runStep = async (
    step: StepDescriptor<unknown>,
    stepNumber: number,
    total: number,
  ): Promise<void> => {
    const outcome = await runInteractiveStep(stepNumber, total, step);
    outcomes.push(outcome);
    if (outcome.status === 'aborted') {
      logger.blank();
      printOutcomeSummary(outcomes);
      throw new SetupAbort(
        'Aborting setup at user request. State so far is saved. No rollback is performed — run "pnpm setup:infra --delete" for manual cleanup URLs.',
      );
    }
  };

  const printPhaseBanner = (title: string): void => {
    logger.blank();
    logger.info('══════════════════════════════════════════════════════════');
    logger.info(`  ${title}`);
    logger.info('══════════════════════════════════════════════════════════');
  };

  if (environmentFirst) {
    const perEnvironmentTotal = selectedProviders.length;
    logger.blank();
    for (
      let environmentIndex = 0;
      environmentIndex < activeEnvironments.length;
      environmentIndex += 1
    ) {
      const environmentName = activeEnvironments[environmentIndex];
      if (!environmentName) continue;
      printPhaseBanner(
        `Environment: ${environmentName}  (${environmentIndex + 1} of ${activeEnvironments.length})`,
      );

      const environmentContext = buildProviderContext(config, secrets, state, [environmentName]);
      let stepNumber = 0;
      for (const provider of selectedProviders) {
        stepNumber += 1;
        const baseStep = provider.buildStep(environmentContext);
        await runStep(
          { ...baseStep, name: `${baseStep.name} · ${environmentName}` },
          stepNumber,
          perEnvironmentTotal,
        );
      }
    }
  } else {
    let stepNumber = 0;
    for (const provider of selectedProviders) {
      stepNumber += 1;
      await runStep(provider.buildStep(context), stepNumber, selectedProviders.length);
    }
  }

  // Finalize: env-agnostic steps, numbered within their own short sequence.
  const finalizeSteps: StepDescriptor<unknown>[] = [buildExportEnvFilesStep(environments)];
  if (githubSyncEnabled) {
    const githubSyncStep = buildGitHubSyncStep(context);
    if (githubSyncStep) finalizeSteps.push(githubSyncStep);
  }
  if (finalizeSteps.length > 0) {
    printPhaseBanner('Finalize');
    for (let index = 0; index < finalizeSteps.length; index += 1) {
      const finalizeStep = finalizeSteps[index];
      if (finalizeStep) await runStep(finalizeStep, index + 1, finalizeSteps.length);
    }
  }

  logger.divider();
  logger.blank();
  printOutcomeSummary(outcomes);
  renderProvisionedDetail(selectedProviders, context, outcomes);
  const { hasFailures } = summarizeOutcomes(outcomes);
  if (hasFailures) {
    logger.warn('Setup finished with some failures (see table above).');
    logger.info(
      'No rollback is performed. Run "pnpm setup:infra --delete" to see dashboard URLs for any partial resources you want to remove manually, then re-run "pnpm setup:infra".',
    );
    process.exitCode = 1;
  } else {
    logger.success('Setup completed successfully! All resources provisioned.');
  }

  // What setup cannot do itself, one step at a time, with live status.
  await runNextSteps(context.config, context.secrets);

  const summaryItems: Array<{ label: string; value: string | string[] }> = [];

  if (state.neon?.projectId) {
    summaryItems.push({ label: 'Neon Project', value: state.neon.projectId });
    for (const [env, branch] of Object.entries(state.neon.branches)) {
      summaryItems.push({ label: `  ${env} branch`, value: branch.branchId });
    }
  }

  if (state.redis?.databases) {
    for (const [env, database] of Object.entries(state.redis.databases)) {
      summaryItems.push({ label: `Railway Redis (${env})`, value: String(database.databaseId) });
    }
  }

  if (state.aws?.buckets) {
    for (const [env, bucket] of Object.entries(state.aws.buckets)) {
      summaryItems.push({ label: `S3 Bucket (${env})`, value: bucket.name });
    }
  }

  if (state.sentry?.projectSlug) {
    summaryItems.push({ label: 'Sentry Project', value: state.sentry.projectSlug });
  }

  if (state.railway?.projectId) {
    summaryItems.push({ label: 'Railway Project', value: state.railway.projectId });
    for (const [environmentName, environmentState] of Object.entries(
      state.railway.environments ?? {},
    )) {
      // One service per line (api / worker / redis) so long service:id pairs don't run off-screen.
      const services = SETUP_SERVICE_NAMES.map((serviceName) => {
        const serviceId = environmentState.services[serviceName]?.serviceId ?? 'missing';
        return `${formatSetupServiceName(serviceName)}:${serviceId}`;
      });
      summaryItems.push({ label: `  ${environmentName} services`, value: services });
    }
  }

  if (state.github?.secrets?.length) {
    summaryItems.push({ label: 'GitHub Secrets', value: state.github.secrets.join(', ') });
  }

  if (summaryItems.length > 0) {
    logger.summary('Provisioned Resources', summaryItems);
  }

  // Post-provision: ask what to do with env files
  promptEnvOutput(environments);
}

// ─── CROSS-CUTTING STEPS (env-file export, GitHub sync) ─────────────────────
//
// These are not third-party providers and therefore not in `INFRA_PROVIDERS`,
// but they share the same StepDescriptor shape so they slot into the loop.

function buildExportEnvFilesStep(environments: string[]): StepDescriptor<unknown> {
  return {
    name: 'Export .env.<environment> files',
    enabled: true,
    instructions: [
      `Will copy .env.example → .env.${environments.join(', .env.')} and replace known values from provisioned state.`,
      'Also writes browser-safe clinozy-fe keys straight into ../clinozy-fe/.env.<environment> (independent target; skipped if clinozy-fe is absent).',
      'Existing files are skipped to preserve local edits. These files are gitignored.',
    ],
    execute: async () => {
      const result = exportEnvFiles();
      if (result.written.length > 0) {
        logger.success(`Created ${result.written.length} file(s): ${result.written.join(', ')}`);
      }
      if (result.merged.length > 0) {
        logger.info(
          `Regenerated ${result.merged.length} existing file(s) with all .env.example keys: ${result.merged.join(', ')}`,
        );
      }
      if (result.frontendWritten.length > 0) {
        logger.success(`Created frontend env file(s): ${result.frontendWritten.join(', ')}`);
      }
      if (result.frontendMerged.length > 0) {
        logger.info(`Regenerated frontend env file(s): ${result.frontendMerged.join(', ')}`);
      }
      return result;
    },
    verifyState: () => ({ ok: true, message: 'env files exported' }),
  };
}

function buildGitHubSyncStep(context: InfraProviderContext): StepDescriptor<unknown> | null {
  if (!context.config.providers.github.enabled) return null;
  if (!context.config.providers.github.syncEnvironments) return null;

  return {
    name: 'Sync .env.<environment> to GitHub Environments',
    enabled: true,
    instructions: [
      `Will reconcile GitHub Environments against local .env files for: ${context.environments.join(', ')}.`,
      'Pushes all secrets and variables from each .env file. Deletes any item on GitHub that is NOT in the local file.',
      'Uses GITHUB_TOKEN from .setup/.setup-credentials. Secrets are encrypted; variables are diffed.',
    ],
    execute: async () => {
      const { syncEnvironmentToGitHub } = await import('@setup/github/sync-github-environments.js');
      let totalPushed = 0;
      let totalSkipped = 0;
      let totalDeleted = 0;
      for (const env of context.environments) {
        const result = await syncEnvironmentToGitHub({
          environment: env,
          dryRun: false,
          skipCreate: false,
          skipPreflight: true,
        });
        totalPushed += result.pushed;
        totalSkipped += result.skipped;
        totalDeleted += result.deleted;
      }
      logger.success(
        `GitHub sync complete — pushed ${totalPushed}, skipped ${totalSkipped}, deleted ${totalDeleted}`,
      );
      return context.environments;
    },
    verifyState: () => ({ ok: true, message: 'GitHub sync complete' }),
  };
}

function printOutcomeSummary(outcomes: StepOutcome<unknown>[]): void {
  const { rows } = summarizeOutcomes(outcomes);
  logger.outcomeSummaryTable(rows);
}

// ─── CHECK ──────────────────────────────────────────────────────────────────

export async function runCheck(
  options: { providerSelection?: ProviderSelectionInput } = {},
): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const environments = getEnvironmentNames(config);
  const providers = selectProviders(options.providerSelection);

  showHeader(config, environments);
  showProviderSelection(providers);
  // State is ephemeral (empty at process start). Hydrate it from live remote so
  // provider `check()` — which reads from state — sees real resources instead of
  // reporting everything "not in state".
  await hydrateStateFromRemote(options);
  const state = loadState();
  const context = buildProviderContext(config, secrets, state, environments);

  logger.info('Running health checks...');
  logger.blank();

  let allHealthy = true;

  for (const provider of providers) {
    if (!provider.check) continue;
    if (!provider.isEnabled(context)) continue;
    const healthy = await provider.check(context);
    if (!healthy) allHealthy = false;
  }

  logger.blank();
  if (allHealthy) {
    logger.success('All resources are healthy.');
  } else {
    logger.error('Some resources have issues. Run "pnpm setup:infra" to re-provision.');
  }
}

// ─── STATUS ─────────────────────────────────────────────────────────────────

export async function runStatus(options: { environments?: string[] } = {}): Promise<void> {
  const config = loadConfig();
  showHeader(config, getEnvironmentNames(config));

  // Offline matrix first (instant — reads .env.<env> / KeyStash), then the live dashboard.
  runStatusMatrix(options.environments);
  logger.blank();

  // State is ephemeral, so hydrate from live remote before reporting — otherwise
  // every environment reads as MISSING on a fresh process.
  await hydrateStateFromRemote();
  const state = loadState();

  const rows: Array<{ env: string; status: string; detail: string }> = [];

  for (const environment of config.environments) {
    const neonOk = !!state.neon?.branches?.[environment.name]?.databaseUrl;
    const redisOk = config.providers.railwayRedis.enabled
      ? !!state.redis?.databases?.[environment.name]?.redisUrl
      : true;
    const awsOk = !!state.aws?.buckets?.[environment.name];
    const jwtOk = !!state.jwt?.[environment.name];

    const allOk = neonOk && redisOk && awsOk && jwtOk;

    const details: string[] = [];
    if (!neonOk) details.push('Neon');
    if (!redisOk) details.push('Railway Redis');
    if (!awsOk) details.push('AWS');
    if (!jwtOk) details.push('JWT');

    rows.push({
      env: environment.name,
      status: allOk ? 'OK' : 'MISSING',
      detail: allOk
        ? `branch: ${environment.deployBranch}; services: ${formatSetupServiceNames(SETUP_SERVICE_NAMES)}`
        : `branch: ${environment.deployBranch}; missing: ${details.join(', ')}`,
    });
  }

  logger.table(rows);

  const sharedItems: Array<{ label: string; value: string }> = [];
  sharedItems.push({ label: 'Sentry', value: state.sentry ? 'configured' : 'not configured' });
  sharedItems.push({
    label: 'Railway',
    value: state.railway?.environments
      ? `${Object.keys(state.railway.environments).length} environments, ${Object.values(
          state.railway.environments,
        ).reduce(
          (count, environment) => count + Object.keys(environment.services).length,
          0,
        )} service attachments`
      : state.railway
        ? `${Object.keys(state.railway.services).length} services`
        : 'not configured',
  });
  sharedItems.push({
    label: 'GitHub Secrets',
    value: state.github ? `${state.github.secrets.length} secrets` : 'not configured',
  });

  logger.summary('Shared Resources', sharedItems);
}

// ─── UPDATE ─────────────────────────────────────────────────────────────────

export async function runUpdate(
  options: { providerSelection?: ProviderSelectionInput } = {},
): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const state = loadState();
  const environments = getEnvironmentNames(config);
  const context = buildProviderContext(config, secrets, state, environments);
  const providers = selectProviders(options.providerSelection);
  const includesGitHub = providers.some((provider) => provider.key === 'github');

  showHeader(config, environments);
  showProviderSelection(providers);
  logger.info('Re-syncing GitHub (branches, rulesets, environments)...');
  logger.blank();

  if (config.providers.github.enabled && includesGitHub) {
    await syncGithubFoundations();
    const result = await githubProvision(config, secrets, state, environments);
    context.applyStateUpdates(result.stateUpdates ?? {});
    if (result.success) {
      logger.success(result.message);
    } else {
      logger.error(result.message);
    }
  } else if (!includesGitHub) {
    logger.warn('No update provider selected. Today --update only supports provider key "github".');
  } else {
    logger.warn('GitHub is disabled in config. Nothing to update.');
  }
}

// ─── RECONSTRUCT ────────────────────────────────────────────────────────────

interface ReconstructStateOptions {
  config: SetupConfig;
  secrets: SetupSecrets;
  state: SetupState;
  environments: string[];
  providers: readonly InfraProvider[];
  /**
   * When true, providers that do not implement `detectRemote` are logged
   * (used by `runReconstruct`). When false, missing hooks are silent (used
   * by the implicit reconstruct phase inside `runProvision`).
   */
  verbose?: boolean;
}

/**
 * Walks every enabled provider that implements `detectRemote`, runs it,
 * persists any state updates synchronously, and returns the total count of
 * remote resources discovered. Used by both `runReconstruct` (explicit
 * `--reconstruct` command) and `runProvision` (implicit pre-flight before
 * the provision loop, so providers always see the freshest remote state and
 * never create duplicates of resources that already exist remotely).
 */
async function reconstructStateFromRemote(
  options: ReconstructStateOptions,
): Promise<{ foundCount: number; updatedProviderKeys: string[] }> {
  const { config, secrets, state, environments, providers, verbose = false } = options;
  let foundCount = 0;
  const updatedProviderKeys: string[] = [];

  for (const provider of providers) {
    if (
      !provider.isEnabled({ config, secrets, state, environments, applyStateUpdates: () => {} })
    ) {
      continue;
    }
    if (!provider.detectRemote) {
      if (verbose) {
        logger.info(`${provider.name} — remote detection not available, skipping`);
      }
      continue;
    }

    const spinner = logger.startSpinner(`Querying ${provider.name}...`);
    try {
      const resources = await provider.detectRemote({
        config,
        secrets,
        state,
        environments,
        applyStateUpdates: (updates: Partial<SetupState>) => {
          Object.assign(state, updates);
          saveState(state);
        },
      });
      const count = Object.keys(resources).length;
      if (count > 0) {
        foundCount += count;
        updatedProviderKeys.push(provider.key);
      }
      logger.stopSpinner(spinner, `${provider.name} — ${count} resource(s) found`);
    } catch (detectError) {
      const message = detectError instanceof Error ? detectError.message : String(detectError);
      logger.stopSpinner(spinner, `${provider.name} — failed: ${message}`, 'fail');
    }
  }

  saveState(state);
  return { foundCount, updatedProviderKeys };
}

export async function runReconstruct(
  options: { providerSelection?: ProviderSelectionInput } = {},
): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const environments = getEnvironmentNames(config);
  const state = loadState();
  const providers = selectProviders(options.providerSelection);

  showHeader(config, environments);
  showProviderSelection(providers);
  logger.info('Reconstructing state from remote providers...');
  logger.blank();

  const { foundCount } = await reconstructStateFromRemote({
    config,
    secrets,
    state,
    environments,
    providers,
    verbose: true,
  });

  logger.blank();
  if (foundCount > 0) {
    logger.success(`Rebuilt state with ${foundCount} resource(s) from remote.`);
  } else {
    logger.warn('No remote resources found. State unchanged.');
  }
}

/**
 * Best-effort hydration of the ephemeral in-memory state from live remote, for standalone
 * commands that need provisioned resource ids/urls (there is no persisted state file). Runs
 * each selected provider's `detectRemote` into the shared in-memory state and returns it.
 * Silent on missing tokens / unreachable providers — the caller proceeds with whatever was
 * found. Quiet (no spinners) so it can run ahead of another command's output.
 */
export async function hydrateStateFromRemote(
  options: { providerSelection?: ProviderSelectionInput } = {},
): Promise<SetupState> {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const environments = getEnvironmentNames(config);
  const state = loadState();
  const providers = selectProviders(options.providerSelection);
  await reconstructStateFromRemote({ config, secrets, state, environments, providers });
  return state;
}

// ─── DELETE INSTRUCTIONS ────────────────────────────────────────────────────
//
// `pnpm setup:infra --delete` is read-only: it never deletes resources. It
// prints, per provider, the dashboard URL and the identifiers the user must
// delete manually. State is ephemeral, so identifiers come from whatever the
// in-memory run state holds (run after a provision/reconstruct for specifics).

export function runDeleteInstructions(
  options: { providerSelection?: ProviderSelectionInput } = {},
): void {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const state = loadState();
  const environments = getEnvironmentNames(config);
  const context = buildProviderContext(config, secrets, state, environments);
  const providers = selectProviders(options.providerSelection);

  showHeader(config, environments);
  showProviderSelection(providers);
  logger.blank();

  const blocks: logger.DeleteInstructionsBlock[] = providers.flatMap((provider) =>
    (provider.deleteInstructions?.(context) ?? []).map((block) => ({
      provider: block.provider,
      dashboardUrl: block.dashboardUrl,
      resources: block.resources,
      ...(block.steps !== undefined ? { steps: block.steps } : {}),
    })),
  );

  logger.deleteInstructionsReview(blocks);
}
