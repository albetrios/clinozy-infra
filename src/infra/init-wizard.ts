import { existsSync, writeFileSync } from 'node:fs';
import { toolPath } from '@setup/common/paths.js';
import {
  createReadline,
  questionWithDefault,
  questionHidden,
  presentLinkStep,
} from '@setup/common/prompts.js';
import {
  writeEnvSetupTemplateIfMissing,
  updateEnvSetupHeader,
  appendMissingEnvSetupVariables,
  getEnvSetupValue,
  setEnvSetupVariable,
} from '@setup/common/secrets.js';
import { loadConfigIfExists } from '@setup/common/config.js';
import { resolveResendFromAddress } from '@setup/common/resend-from.js';
import { SetupError } from '@setup/common/setup-error.js';
import { assertInteractive } from '@setup/common/interactive-step.js';
import * as logger from '@setup/common/logger.js';
import { buildDefaultArtifacts } from '@setup/identity/project-identity.util.js';
import { runGuide } from '@setup/infra/setup-guide/index.js';
import { renderInfraConfigTs } from '@setup/infra/scaffold-config.js';
import { PRESETS } from '@setup/presets/index.js';
import type { SetupConfig } from '@setup/common/types.js';

const SETUP_CONFIG_PATH = toolPath('setup.config.json');

export const DEFAULT_PROJECT_NAME = 'clinozy-be';
export const DEFAULT_DISPLAY_NAME = 'Clinozy Backend';
export const DEFAULT_ORGANIZATION = 'my-org';
export const DEFAULT_ENVIRONMENTS = 'development,production';

/**
 * Canonical environment → git branch mapping. Always use full names
 * (`development`, `production`) for environments; branches stay short
 * (`dev`, `main`). Add new entries here when an environment is introduced.
 */
const DEFAULT_BRANCH_FOR_ENVIRONMENT: Record<string, string> = {
  development: 'dev',
  production: 'main',
};

/**
 * Whether the branch backing this environment is protected by default
 * (required-checks, restricted pushes, etc.). `development` and `production`
 * are protected; preview / ephemeral environments default to unprotected.
 */
const DEFAULT_PROTECTED_FOR_ENVIRONMENT: Record<string, boolean> = {
  development: true,
  production: true,
};

export function isProductionEnvironmentName(name: string): boolean {
  return name === 'production';
}

export function labelForEnvironmentName(name: string): string {
  if (name === 'development') return 'Development';
  if (name === 'production') return 'Production';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function defaultBranchForEnvironmentName(name: string): string {
  return DEFAULT_BRANCH_FOR_ENVIRONMENT[name] ?? name;
}

export function defaultProtectedForEnvironmentName(name: string): boolean {
  return DEFAULT_PROTECTED_FOR_ENVIRONMENT[name] ?? false;
}

export function buildEnvironmentsFromNames(names: string[]): SetupConfig['environments'] {
  return names.map((name, index) => ({
    name,
    label: labelForEnvironmentName(name),
    nodeEnvironment: isProductionEnvironmentName(name) ? 'production' : 'development',
    deployBranch: defaultBranchForEnvironmentName(name),
    protected: defaultProtectedForEnvironmentName(name),
    isDefault: index === 0,
  }));
}

/**
 * Per-prompt Sentry overrides collected by the init wizard. Each is optional so
 * non-interactive callers (and existing tests) keep the historical defaults:
 * organization → project organization, project → project name, no team,
 * platform → 'node'.
 */
export interface SentryConfigOptions {
  organization?: string;
  project?: string;
  team?: string;
  platform?: string;
}

export function buildConfig(
  organization: string,
  projectName: string,
  displayName: string,
  environmentNames: string[],
  sentryOptions: SentryConfigOptions = {},
): SetupConfig {
  const environments = buildEnvironmentsFromNames(environmentNames);

  const rateLimitMax: Record<string, number> = {};
  const frontendUrl: Record<string, string> = {};
  const allowedOrigins: Record<string, string> = {};
  const sampleRates: Record<string, { traces: number; profile: number }> = {};

  for (const name of environmentNames) {
    const isProduction = isProductionEnvironmentName(name);
    const isDevelopment = name === 'development';
    rateLimitMax[name] = isDevelopment ? 10000 : isProduction ? 100 : 1000;
    // `app.frontendUrl` is the API origin (legacy name); CORS lists the SPA origins that call it.
    // Development mirrors the backend's .env.example (API on :3000, Vite SPA on :5173).
    frontendUrl[name] = isDevelopment
      ? 'http://localhost:3000'
      : isProduction
        ? 'https://api.example.com'
        : `https://${name}-api.example.com`;
    allowedOrigins[name] = isDevelopment
      ? 'http://localhost:3000,http://localhost:5173'
      : isProduction
        ? 'https://app.example.com'
        : `https://${name}.example.com`;
    sampleRates[name] = isDevelopment
      ? { traces: 1, profile: 1 }
      : isProduction
        ? { traces: 0.1, profile: 0.1 }
        : { traces: 0.5, profile: 0.5 };
  }

  const artifacts = buildDefaultArtifacts(projectName);
  const protectedBranches = environments.map((environment) => environment.deployBranch);
  const defaultBranch =
    environments.find((environment) => environment.isDefault)?.deployBranch ?? protectedBranches[0];

  return {
    project: {
      name: projectName,
      displayName,
      organization,
      artifacts,
    },
    git: {
      protectedBranches,
      defaultBranch,
    },
    environments,
    providers: {
      neon: {
        enabled: true,
        region: 'aws-us-east-2',
        pgVersion: 17,
        computeSize: { min: 0.25, max: 1 },
        historyRetentionDays: { development: 1, production: 7 },
      },
      railwayRedis: {
        enabled: true,
        region: 'asia-southeast1-eqsg3a',
        cpuLimit: 1,
        memoryLimitMb: 512,
      },
      aws: {
        enabled: true,
        region: 'us-east-1',
        s3BucketPrefix: projectName,
        iamUserPrefix: `${projectName}-s3`,
      },
      sentry: {
        enabled: true,
        organization: sentryOptions.organization ?? organization,
        project: sentryOptions.project ?? projectName,
        ...(sentryOptions.team ? { team: sentryOptions.team } : {}),
        platform: sentryOptions.platform ?? 'node',
        sampleRates,
      },
      resend: {
        // Empty => derived from project identity (noreply@<project-name>.com / displayName),
        // so a rename auto-updates the sender. Override with a verified domain when needed.
        enabled: true,
        fromAddress: '',
        fromName: '',
      },
      stripe: { enabled: true },
      oauth: {
        google: { enabled: true },
        github: { enabled: true },
      },
      posthog: { enabled: true, region: 'us' },
      turnstile: { enabled: true },
      railway: { enabled: true },
      github: {
        enabled: true,
        repository: `${organization}/${projectName}`,
        syncEnvironments: true,
      },
      postman: { enabled: true },
      scalar: { enabled: true },
      netlify: { enabled: true },
    },
    app: {
      port: 3000,
      host: '0.0.0.0',
      rateLimitMax,
      rateLimitWindowMs: 60000,
      frontendUrl,
      allowedOrigins,
    },
  };
}

export async function runInitWizard(): Promise<void> {
  assertInteractive();
  logger.info(
    'Setup init — we will ask for organization, project, environments, and Sentry slugs, then generate setup.config.json.',
  );
  logger.blank();

  const existingConfig = loadConfigIfExists();
  const defaultOrganization = existingConfig?.project.organization ?? DEFAULT_ORGANIZATION;
  const defaultProjectName = existingConfig?.project.name ?? DEFAULT_PROJECT_NAME;
  const defaultDisplayName = existingConfig?.project.displayName ?? DEFAULT_DISPLAY_NAME;
  const defaultEnvironments =
    existingConfig?.environments.map((environment) => environment.name).join(', ') ??
    DEFAULT_ENVIRONMENTS;

  const readline = createReadline();

  const organization = await questionWithDefault(
    readline,
    'Organization name',
    defaultOrganization,
  );
  const projectName = await questionWithDefault(readline, 'Project name', defaultProjectName);
  const displayName = await questionWithDefault(
    readline,
    'Project display name',
    defaultDisplayName,
  );
  const envInput = await questionWithDefault(
    readline,
    'Environments (comma-separated, full names — e.g. development,production)',
    defaultEnvironments,
  );

  const defaultNeonOrgId = getEnvSetupValue('NEON_ORG_ID');
  presentLinkStep({
    title: 'Neon Organization ID — needed to provision the Postgres database',
    url: 'https://console.neon.tech/app/settings',
    steps: [
      'Sign in to Neon (the link is on your clipboard — just paste it).',
      'Select your Organization, then open Settings → General.',
      'Copy the "Organization ID" (looks like org-soft-block-10705736).',
      'Paste it at the prompt below (or press Enter to keep the current value).',
    ],
  });
  const neonOrgId = await questionWithDefault(
    readline,
    'Neon Organization ID (e.g. org-soft-block-10705736)',
    defaultNeonOrgId,
  );

  // Sentry slugs come from https://sentry.io/settings/ and can differ from the
  // project organization (the org slug often carries a suffix, e.g. "-7j"). Each
  // prompt defaults to the existing setup.config.json value (press Enter to keep it).
  const sentryDefaults = existingConfig?.providers.sentry;
  presentLinkStep({
    title: 'Sentry slugs — organization, team, project (press Enter on each to keep the default)',
    url: 'https://sentry.io/settings/',
    steps: [
      'Sign in to Sentry (the link is on your clipboard — just paste it).',
      'Organization slug: it is in the URL (/settings/<org-slug>/) — it may carry a suffix like "-7j".',
      'Team slug: Settings → Teams → the team that will own the project.',
      'Project slug + platform: Settings → Projects → your project.',
    ],
  });
  const sentryOrganization = await questionWithDefault(
    readline,
    'Sentry organization slug',
    sentryDefaults?.organization ?? organization,
  );
  const sentryProject = await questionWithDefault(
    readline,
    'Sentry project slug',
    sentryDefaults?.project ?? projectName,
  );
  const sentryTeam = await questionWithDefault(
    readline,
    'Sentry team slug (the team the project is created under)',
    sentryDefaults?.team ?? '',
  );
  const sentryPlatform = await questionWithDefault(
    readline,
    'Sentry platform (e.g. node, node-fastify, javascript-react)',
    sentryDefaults?.platform ?? 'node',
  );

  readline.close();

  const environmentNames = envInput
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (environmentNames.length === 0) {
    throw new SetupError(
      'At least one environment is required (full names — e.g. development or development,production).',
    );
  }

  const sentryOptions: SentryConfigOptions = {
    organization: sentryOrganization,
    project: sentryProject,
    platform: sentryPlatform,
  };
  const trimmedSentryTeam = sentryTeam.trim();
  if (trimmedSentryTeam) {
    sentryOptions.team = trimmedSentryTeam;
  }

  const config = buildConfig(
    organization,
    projectName,
    displayName,
    environmentNames,
    sentryOptions,
  );

  writeFileSync(SETUP_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  logger.success(`Wrote ${SETUP_CONFIG_PATH}`);
  logger.info(`  Project: ${config.project.displayName} (${config.project.name})`);
  logger.info(`  Organization: ${config.project.organization}`);
  logger.info(
    `  Sentry: ${config.providers.sentry.organization}/${config.providers.sentry.project}` +
      `${config.providers.sentry.team ? ` (team ${config.providers.sentry.team})` : ''}` +
      ` · ${config.providers.sentry.platform}`,
  );
  logger.info(`  Environments: ${environmentNames.join(', ')}`);
  logger.blank();

  if (writeEnvSetupTemplateIfMissing(config)) {
    logger.success(
      'Wrote .setup/.setup-credentials (template with URLs for each key). Fill values then run pnpm setup:infra.',
    );
  } else {
    updateEnvSetupHeader(config);
    const addedKeys = appendMissingEnvSetupVariables(config);
    if (addedKeys.length > 0) {
      logger.success(
        `Added missing variable(s) to .setup/.setup-credentials: ${addedKeys.join(', ')}`,
      );
    }
    logger.info(
      'Updated .setup/.setup-credentials header (Project/Organization/Environments). Edit secrets as needed, then run pnpm setup:infra.',
    );
  }

  if (neonOrgId.trim()) {
    setEnvSetupVariable('NEON_ORG_ID', neonOrgId.trim());
    logger.success('Set NEON_ORG_ID in .setup/.setup-credentials');
  }

  // Sentry auth token — a SECRET. Collected last (the main prompt readline is
  // already closed) via hidden input and written only to .setup/.setup-credentials.
  const existingSentryToken = getEnvSetupValue('SENTRY_AUTH_TOKEN');
  presentLinkStep({
    title: existingSentryToken
      ? 'Sentry auth token — already set (press Enter to keep it, or paste a new one to replace)'
      : 'Sentry auth token — needed to create/adopt the project and upload source maps',
    url: 'https://sentry.io/settings/auth-tokens/new-token/',
    steps: [
      'Sign in to Sentry (the link is on your clipboard — just paste it).',
      'Name the token (e.g. "clinozy-be setup").',
      'Grant scopes: project:read, project:write, project:admin, org:read.',
      'Click "Create token" and copy the value.',
      'Paste it at the prompt below — input stays hidden and is saved only to .setup/.setup-credentials.',
    ],
  });
  const sentryAuthToken = await questionHidden(
    existingSentryToken
      ? 'Paste Sentry auth token (hidden — Enter to keep current): '
      : 'Paste Sentry auth token (hidden): ',
  );
  if (sentryAuthToken.trim()) {
    setEnvSetupVariable('SENTRY_AUTH_TOKEN', sentryAuthToken.trim());
    logger.success('Saved SENTRY_AUTH_TOKEN to .setup/.setup-credentials (value hidden).');
  } else if (!existingSentryToken) {
    logger.warn(
      'No Sentry auth token entered — fill SENTRY_AUTH_TOKEN in .setup/.setup-credentials before running pnpm setup:infra.',
    );
  }

  // Resend API key — a SECRET. Hidden input, saved only to .setup/.setup-credentials.
  // Only prompt when Resend is enabled in the config we just built.
  if (config.providers.resend.enabled) {
    const existingResendKey = getEnvSetupValue('RESEND_API_KEY');
    presentLinkStep({
      title: existingResendKey
        ? 'Resend API key — already set (press Enter to keep it, or paste a new one to replace)'
        : 'Resend API key — needed to send transactional email',
      url: 'https://resend.com/api-keys',
      steps: [
        'Sign in to Resend (the link is on your clipboard — just paste it).',
        'Click "Create API Key".',
        `Name it (e.g. "${config.project.name} setup") and pick permission "Sending access".`,
        'Click "Add", then copy the key — it is shown only once and starts with "re_".',
        'Paste it at the prompt below — input stays hidden and is saved only to .setup/.setup-credentials.',
      ],
    });
    const resendApiKey = await questionHidden(
      existingResendKey
        ? 'Paste Resend API key (hidden — Enter to keep current): '
        : 'Paste Resend API key (hidden): ',
    );
    if (resendApiKey.trim()) {
      setEnvSetupVariable('RESEND_API_KEY', resendApiKey.trim());
      logger.success('Saved RESEND_API_KEY to .setup/.setup-credentials (value hidden).');
    } else if (!existingResendKey) {
      logger.warn(
        'No Resend API key entered — fill RESEND_API_KEY in .setup/.setup-credentials before running pnpm setup:infra.',
      );
    }
    logger.info(
      `Sender is ${resolveResendFromAddress(config)} — verify that domain at https://resend.com/domains or delivery will fail.`,
    );
  }

  // Scaffold infra.config.ts (the resource composition) if this project doesn't have one yet.
  const infraConfigPath = toolPath('infra.config.ts');
  if (!existsSync(infraConfigPath)) {
    writeFileSync(infraConfigPath, renderInfraConfigTs(PRESETS), 'utf-8');
    logger.success(`Wrote ${infraConfigPath} (${PRESETS.length} resources — edit to add/remove).`);
  }

  // Generate the human setup guide so a new dev has it immediately — open it in a browser
  // to see every key, where to get it, and where it goes (per environment, live status).
  logger.blank();
  try {
    runGuide();
  } catch (error) {
    logger.warn(
      `Could not generate the setup guide (run \`pnpm setup:infra:guide\` later): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
