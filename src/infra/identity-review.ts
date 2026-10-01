/**
 * Project / organization / branches / environments review.
 *
 * Runs at the start of `pnpm setup:infra`. Loads the existing answers from
 * `tooling/setup/setup.config.json` (the file doubles as the persisted
 * "saved answers" so users don't re-enter values on every run).
 *
 * Flow:
 *   1. If no config → seed with defaults.
 *   2. Print current values (project, organization, environments + branches + services).
 *   3. Ask: keep / edit / abort.
 *   4. On edit, walk through prompts (each pre-filled with the current value).
 *   5. Persist back to setup.config.json.
 */
import * as logger from '@setup/common/logger.js';
import { SetupAbort, SetupError } from '@setup/common/setup-error.js';
import { loadConfigIfExists, saveConfig } from '@setup/common/config.js';
import { createReadline, questionWithDefault, isAssumeYes } from '@setup/common/prompts.js';
import {
  deriveResendFromAddress,
  deriveResendFromName,
  resolveResendFromAddress,
  resolveResendFromName,
} from '@setup/common/resend-from.js';
import {
  DEFAULT_DISPLAY_NAME,
  DEFAULT_ENVIRONMENTS,
  DEFAULT_ORGANIZATION,
  DEFAULT_PROJECT_NAME,
  buildConfig,
  buildEnvironmentsFromNames,
  defaultBranchForEnvironmentName,
  defaultProtectedForEnvironmentName,
  isProductionEnvironmentName,
  labelForEnvironmentName,
} from './init-wizard.js';
import type { SetupConfig } from '@setup/common/types.js';

/**
 * State keys for Railway services expected in each environment after setup.
 * `api` and `worker` are created by the Railway provider as blank shells;
 * `redis` is provisioned by the Railway Redis provider from Railway's `redis`
 * database template (template-managed image, password, and volume).
 */
export const SETUP_SERVICE_NAMES = ['api', 'worker', 'redis'];

export function formatSetupServiceName(serviceName: string): string {
  return serviceName === 'redis' ? 'redis (database template)' : serviceName;
}

export function formatSetupServiceNames(serviceNames: readonly string[]): string {
  return serviceNames.map(formatSetupServiceName).join(', ');
}

type ReviewAction = 'keep' | 'edit' | 'abort';

function createDefaultConfig(): SetupConfig {
  const environmentNames = DEFAULT_ENVIRONMENTS.split(',').map((name) => name.trim());
  return buildConfig(
    DEFAULT_ORGANIZATION,
    DEFAULT_PROJECT_NAME,
    DEFAULT_DISPLAY_NAME,
    environmentNames,
  );
}

function printIdentitySummary(config: SetupConfig): void {
  logger.blank();
  logger.info('Saved project identity (defaults loaded from tooling/setup/setup.config.json):');
  logger.info(`    Product name        : ${config.product?.name ?? '—'}`);
  logger.info(`    Project name        : ${config.project.name}`);
  logger.info(`    Project displayName : ${config.project.displayName}`);
  logger.info(`    Organization        : ${config.project.organization}`);
  logger.info(`    GitHub repository   : ${config.providers.github.repository}`);
  logger.info(
    `    Email from          : ${resolveResendFromName(config)} <${resolveResendFromAddress(config)}>`,
  );
  for (const environment of config.environments) {
    const defaultMark = environment.isDefault ? ' (default)' : '';
    logger.info(
      `    Environment         : ${environment.name} (${environment.label}) — branch "${environment.deployBranch}" — services: ${formatSetupServiceNames(SETUP_SERVICE_NAMES)}${defaultMark}`,
    );
  }
  logger.blank();
}

async function askKeepEditAbort(
  readline: ReturnType<typeof createReadline>,
): Promise<ReviewAction> {
  if (isAssumeYes()) return 'keep';
  const answer = (
    await questionWithDefault(
      readline,
      '  Keep these values? (Y to keep / E to edit / N to abort)',
      'Y',
    )
  )
    .trim()
    .toLowerCase();
  if (answer === 'y' || answer === 'yes' || answer === '') return 'keep';
  if (answer === 'e' || answer === 'edit') return 'edit';
  if (answer === 'n' || answer === 'no' || answer === 'abort') return 'abort';
  logger.warn(`Unrecognized answer "${answer}" — keeping current values.`);
  return 'keep';
}

function parseEnvironmentNames(input: string): string[] {
  return input
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

async function editIdentity(config: SetupConfig): Promise<SetupConfig> {
  const readline = createReadline();

  const organization = await questionWithDefault(
    readline,
    '  Organization name',
    config.project.organization,
  );
  const projectName = await questionWithDefault(
    readline,
    '  Project name (used for Railway, S3, Sentry, etc.)',
    config.project.name,
  );
  const displayName = await questionWithDefault(
    readline,
    '  Project display name',
    config.project.displayName,
  );
  const repository = await questionWithDefault(
    readline,
    '  GitHub repository (owner/name)',
    config.providers.github.repository,
  );

  // Email "from" identity. Defaults derive from the project (name/displayName) so a
  // rename auto-updates them; when the entered value matches the derived default we
  // persist '' to keep it dynamic, and only store a literal for an explicit override.
  const derivedFromName = deriveResendFromName(displayName);
  const fromNameInput = (
    await questionWithDefault(
      readline,
      '  Email "from" name',
      config.providers.resend.fromName.trim() || derivedFromName,
    )
  ).trim();
  const derivedFromAddress = deriveResendFromAddress(projectName);
  const fromAddressInput = (
    await questionWithDefault(
      readline,
      '  Email "from" address',
      config.providers.resend.fromAddress.trim() || derivedFromAddress,
    )
  ).trim();
  const fromName = fromNameInput === derivedFromName ? '' : fromNameInput;
  const fromAddress = fromAddressInput === derivedFromAddress ? '' : fromAddressInput;

  const environmentNamesInput = await questionWithDefault(
    readline,
    '  Environments (comma-separated, full names — e.g. development,production)',
    config.environments.map((environment) => environment.name).join(','),
  );
  const environmentNames = parseEnvironmentNames(environmentNamesInput);
  if (environmentNames.length === 0) {
    readline.close();
    throw new SetupError('At least one environment is required.');
  }

  const branchByName = new Map<string, string>();
  const labelByName = new Map<string, string>();
  for (const name of environmentNames) {
    const existing = config.environments.find((environment) => environment.name === name);
    const defaultBranch = existing?.deployBranch ?? defaultBranchForEnvironmentName(name);
    const branch = await questionWithDefault(readline, `  Branch for "${name}"`, defaultBranch);
    branchByName.set(name, branch);

    const defaultLabel = existing?.label ?? labelForEnvironmentName(name);
    const label = await questionWithDefault(readline, `  Label for "${name}"`, defaultLabel);
    labelByName.set(name, label);
  }

  readline.close();

  const baseEnvironments = buildEnvironmentsFromNames(environmentNames);
  const updatedEnvironments = baseEnvironments.map((environment, index) => {
    const existing = config.environments.find((current) => current.name === environment.name);
    return {
      ...environment,
      deployBranch: branchByName.get(environment.name) ?? environment.deployBranch,
      label: labelByName.get(environment.name) ?? environment.label,
      protected: existing?.protected ?? defaultProtectedForEnvironmentName(environment.name),
      isDefault: existing?.isDefault ?? index === 0,
      nodeEnvironment:
        existing?.nodeEnvironment ??
        (isProductionEnvironmentName(environment.name) ? 'production' : 'development'),
    };
  });

  const perEnvironmentScalar = <T>(
    source: Record<string, T> | undefined,
    fallback: T,
  ): Record<string, T> => {
    const result: Record<string, T> = {};
    for (const name of environmentNames) {
      result[name] = source?.[name] ?? fallback;
    }
    return result;
  };

  const updated: SetupConfig = {
    ...config,
    project: {
      ...config.project,
      name: projectName,
      displayName,
      organization,
    },
    environments: updatedEnvironments,
    providers: {
      ...config.providers,
      aws: {
        ...config.providers.aws,
        s3BucketPrefix: projectName,
        iamUserPrefix: `${projectName}-s3`,
      },
      sentry: {
        ...config.providers.sentry,
        organization,
        project: config.providers.sentry.project ?? projectName,
        sampleRates: perEnvironmentScalar(config.providers.sentry.sampleRates, {
          traces: 0.5,
          profile: 0.5,
        }),
      },
      github: {
        ...config.providers.github,
        repository,
      },
      resend: {
        ...config.providers.resend,
        fromName,
        fromAddress,
      },
    },
    app: {
      ...config.app,
      rateLimitMax: perEnvironmentScalar(config.app.rateLimitMax, 1000),
      frontendUrl: perEnvironmentScalar(config.app.frontendUrl, ''),
      allowedOrigins: perEnvironmentScalar(config.app.allowedOrigins, ''),
    },
  };

  return updated;
}

export async function reviewProjectIdentity(): Promise<SetupConfig> {
  let config = loadConfigIfExists();
  let needsSave = false;

  if (!config) {
    config = createDefaultConfig();
    needsSave = true;
    logger.info(
      'No tooling/setup/setup.config.json found — using defaults; you can edit them now.',
    );
  }

  printIdentitySummary(config);

  const skipReview =
    process.env.SETUP_INFRA_SKIP_IDENTITY_REVIEW === '1' ||
    process.env.SETUP_INFRA_SKIP_IDENTITY_REVIEW === 'true';

  if (skipReview) {
    logger.info(
      'Skipping identity review (SETUP_INFRA_SKIP_IDENTITY_REVIEW). Keeping saved project identity.',
    );
    if (needsSave) {
      saveConfig(config);
      logger.success(
        'Saved project identity to tooling/setup/setup.config.json (used as defaults next time).',
      );
    }
    return config;
  }

  const readline = createReadline();
  let action: ReviewAction;
  try {
    action = await askKeepEditAbort(readline);
  } finally {
    readline.close();
  }

  if (action === 'abort') {
    throw new SetupAbort('Aborted. No resources were created.');
  }

  if (action === 'edit') {
    config = await editIdentity(config);
    needsSave = true;
    logger.blank();
    printIdentitySummary(config);
  }

  if (needsSave) {
    saveConfig(config);
    logger.success(
      'Saved project identity to tooling/setup/setup.config.json (used as defaults next time).',
    );
  } else {
    logger.info('Keeping saved project identity.');
  }

  return config;
}
