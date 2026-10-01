import { execSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as logger from '@setup/common/logger.js';
import { SetupAbort } from '@setup/common/setup-error.js';
import {
  ensureEnvSetupTemplate,
  reloadSecrets,
  isSecretFilled,
  getSecretsPath,
  getEnvSetupValue,
  setEnvSetupVariable,
} from '@setup/common/secrets.js';
import { hasGithubToken } from '@setup/common/secrets.js';
import { questionHidden, isAssumeYes } from '@setup/common/prompts.js';
import { clipboardAvailable, copyToClipboard } from '@setup/common/clipboard.js';
import {
  oauthAppDisplayName,
  oauthCallbackUrl,
  everyEnvironmentHasEnvKeys,
  productResourceName,
} from '@setup/envs/env-file-setup.util.js';
import { readEnvFileValue } from '@setup/envs/read-env-file.js';
import { posthogGuideConfigured } from '@setup/infra/providers/setup-posthog/setup-posthog.provider.js';
import { githubAppWithOauthGuideConfigured } from '@setup/infra/providers/setup-github-app-with-oauth/setup-github-app-with-oauth.provider.js';
import type { SetupConfig } from '@setup/common/types.js';

function openBrowser(url: string): void {
  const platform = process.platform;
  // No shell — the URL is a single argv element, never interpolated into a command line.
  const [command, args]: [string, string[]] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.error || (typeof result.status === 'number' && result.status !== 0)) {
    logger.warn(`Could not open browser. Please open manually: ${url}`);
  }
}

async function waitForEnter(prompt: string): Promise<void> {
  if (isAssumeYes()) return;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    readline.question(prompt, () => {
      readline.close();
      resolve();
    });
  });
}

/** A value to collect via hidden input and write into `.setup-credentials` for the user. */
interface GuideSecretPrompt {
  /** Env var name in `.setup-credentials` (e.g. `CAPTCHA_SECRET`). */
  key: string;
  /** What to ask the user (e.g. `Turnstile SECRET key (0x4AAA…)`). */
  label: string;
}

interface GuideStepDefinition {
  providerName: string;
  enabledCheck: (config: SetupConfig) => boolean;
  secretsCheck: (secrets: ReturnType<typeof reloadSecrets>) => boolean;
  browserUrls: string[];
  instructions: string[];
  /** When set, this step is run once per environment (environment-first when multiple envs). */
  scope?: 'account' | 'per-environment';
  secretsCheckForEnvironment?: (environmentName: string) => boolean;
  instructionsForEnvironment?: (config: SetupConfig, environmentName: string) => string[];
  browserUrlsForEnvironment?: (config: SetupConfig, environmentName: string) => string[];
  /**
   * Optional values to collect interactively (hidden input) and write straight into
   * `.setup-credentials`. When present, the guide prompts for each missing one instead of
   * asking the user to hand-edit the file. Omit for providers whose values live in
   * `.env.<environment>` (Stripe, OAuth) — those keep the manual-edit flow.
   */
  secretPrompts?: GuideSecretPrompt[];
}

function environmentHasGuideKeys(environmentName: string, keys: string[]): boolean {
  return keys.every((key) => isSecretFilled(readEnvFileValue(environmentName, key)));
}

function buildStripeGuideInstructionsForEnvironment(
  _config: SetupConfig,
  environmentName: string,
): string[] {
  const lines = [`--- ${environmentName} → .env.${environmentName} ---`];
  if (environmentName === 'development') {
    lines.push('1. Dashboard → account picker → Sandboxes → create a sandbox');
    lines.push('2. Developers → API keys → copy sk_test_… and pk_test_…');
  } else if (environmentName === 'production') {
    lines.push('1. Live Dashboard → Developers → API keys → copy sk_live_… and pk_live_…');
  } else {
    lines.push(
      `1. Dashboard → API keys for the Stripe account/mode you use for ${environmentName}`,
    );
  }
  lines.push(
    '2. Developers → Webhooks → add endpoint <public API URL>/api/v1/billing/webhook → copy signing secret (whsec_…)',
  );
  lines.push(
    '   Local dev: `stripe listen --forward-to localhost:3000/api/v1/billing/webhook` prints a whsec_.',
  );
  lines.push(
    `3. Paste STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET when prompted → .env.${environmentName}`,
  );
  lines.push(
    'Publishable keys are browser-safe — export for clinozy-fe via `pnpm setup:infra:frontend`.',
  );
  return lines;
}

function buildGoogleGuideInstructionsForEnvironment(
  config: SetupConfig,
  environmentName: string,
): string[] {
  const appName = oauthAppDisplayName(config.project.name, environmentName);
  const callbackUrl =
    oauthCallbackUrl(config, environmentName, 'google') ||
    'https://<your-frontend>/callback/google';
  return [
    `--- ${environmentName} → .env.${environmentName} ---`,
    '1. Google Cloud Console → APIs & Services → Credentials',
    '2. OAuth consent screen → External → add your account under Test users (while in Testing)',
    '3. Create Credentials → OAuth client ID → Web application',
    `4. Application name: "${appName}"`,
    `5. Authorized redirect URI (the SPA's /callback/google page, NOT the backend API — exact match): ${callbackUrl}`,
    `6. In .env.${environmentName} set (or paste at apply):`,
    '   OAUTH_GOOGLE_CLIENT_ID=….apps.googleusercontent.com',
    '   OAUTH_GOOGLE_CLIENT_SECRET=…',
    `   OAUTH_GOOGLE_REDIRECT_URI=${callbackUrl}`,
  ];
}

function buildGithubGuideInstructionsForEnvironment(
  config: SetupConfig,
  environmentName: string,
): string[] {
  const callbackUrl =
    oauthCallbackUrl(config, environmentName, 'github') ||
    'https://<your-frontend>/callback/github';
  return [
    `--- ${environmentName} → .env.${environmentName} ---`,
    '1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App',
    `2. Callback URL (the SPA's /callback/github page, NOT the backend API — exact): ${callbackUrl}`,
    '3. Enable user authorization (OAuth); copy Client ID + Client secret',
    `4. In .env.${environmentName} set (or paste at apply):`,
    '   OAUTH_GITHUB_CLIENT_ID=…',
    '   OAUTH_GITHUB_CLIENT_SECRET=…',
    `   OAUTH_GITHUB_REDIRECT_URI=${callbackUrl}`,
    'Recommended at apply: SETUP_INFRA_GITHUB_OAUTH_PASTE_ONLY=1 (no browser manifest).',
  ];
}

function buildGuideSteps(config: SetupConfig): GuideStepDefinition[] {
  const secretsPath = getSecretsPath();

  const steps: GuideStepDefinition[] = [
    {
      providerName: 'Neon Postgres',
      enabledCheck: (configuration) => configuration.providers.neon.enabled,
      secretsCheck: (secrets) => isSecretFilled(secrets.neon.apiKey),
      browserUrls: ['https://console.neon.tech/app/settings/api-keys'],
      secretPrompts: [
        { key: 'NEON_API_KEY', label: 'Neon API key (napi_…)' },
        { key: 'NEON_ORG_ID', label: 'Neon Org ID' },
      ],
      instructions: [
        '1. Log in to your Neon account (or sign up at neon.tech)',
        '2. You will land on the "API Keys" page',
        '3. Click "Create new API key"',
        `4. Name it: ${config.project.name}-setup`,
        '5. Copy the generated key (starts with napi_...)',
        `6. In ${secretsPath} set: NEON_API_KEY=<paste-here>`,
        '',
        '7. Save the file',
      ],
    },
    {
      providerName: 'AWS IAM',
      enabledCheck: (configuration) => configuration.providers.aws.enabled,
      secretsCheck: (secrets) =>
        isSecretFilled(secrets.aws.accessKeyId) && isSecretFilled(secrets.aws.secretAccessKey),
      browserUrls: ['https://console.aws.amazon.com/iam/home#/users'],
      secretPrompts: [
        { key: 'AWS_ACCESS_KEY_ID', label: 'AWS Access Key ID' },
        { key: 'AWS_SECRET_ACCESS_KEY', label: 'AWS Secret Access Key' },
      ],
      instructions: [
        '1. Log in to AWS Console',
        '2. You will land on the IAM Users page',
        '3. Click "Create user"',
        `4. User name: ${config.providers.aws.iamUserPrefix}-setup`,
        '5. Click "Next" → "Attach policies directly"',
        '6. Search and attach: AmazonS3FullAccess, IAMFullAccess',
        '7. Click "Create user"',
        '8. Click on the new user → "Security credentials" tab',
        '9. Click "Create access key" → "Application running outside AWS"',
        `10. In ${secretsPath} set: AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...`,
        '',
        '11. Save the file',
      ],
    },
    {
      providerName: 'Sentry',
      enabledCheck: (configuration) => configuration.providers.sentry.enabled,
      secretsCheck: (secrets) => isSecretFilled(secrets.sentry.authToken),
      browserUrls: ['https://sentry.io/settings/auth-tokens/new-token/'],
      secretPrompts: [{ key: 'SENTRY_AUTH_TOKEN', label: 'Sentry auth token (sntrys_…)' }],
      instructions: [
        '1. Log in to Sentry (or sign up at sentry.io)',
        '2. You will land on "Create New Token"',
        '3. Select scopes: project:admin, project:write, project:read',
        '4. Click "Create Token"',
        '5. Copy the token (starts with sntrys_...)',
        `6. In ${secretsPath} set: SENTRY_AUTH_TOKEN=<paste-here>`,
        '',
        '7. Save the file',
      ],
    },
    {
      providerName: 'Resend',
      enabledCheck: (configuration) => configuration.providers.resend.enabled,
      secretsCheck: (secrets) => isSecretFilled(secrets.resend.apiKey),
      browserUrls: ['https://resend.com/api-keys'],
      secretPrompts: [{ key: 'RESEND_API_KEY', label: 'Resend API key (re_…)' }],
      instructions: [
        '1. Log in to Resend (or sign up at resend.com)',
        '2. You will land on the "API Keys" page',
        '3. Click "Create API Key"',
        `4. Name it: ${config.project.name}`,
        '5. Permission: "Full access"',
        '6. Copy the key (starts with re_...)',
        `7. In ${secretsPath} set: RESEND_API_KEY=<paste-here>`,
        '',
        '8. Save the file',
      ],
    },
    {
      providerName: 'Stripe',
      scope: 'per-environment',
      enabledCheck: (configuration) => configuration.providers.stripe.enabled,
      secretsCheck: () => everyEnvironmentHasEnvKeys(config, ['STRIPE_SECRET_KEY']),
      secretsCheckForEnvironment: (environmentName) =>
        environmentHasGuideKeys(environmentName, ['STRIPE_SECRET_KEY']),
      instructionsForEnvironment: buildStripeGuideInstructionsForEnvironment,
      browserUrlsForEnvironment: (_configuration, environmentName) =>
        environmentName === 'production'
          ? ['https://dashboard.stripe.com/apikeys']
          : ['https://dashboard.stripe.com/test/apikeys'],
      browserUrls: [],
      instructions: [
        'At apply, paste keys per environment when prompted.',
        'With multiple environments, setup runs all providers for development first, then production.',
      ],
    },
    {
      providerName: 'Google OAuth',
      scope: 'per-environment',
      enabledCheck: (configuration) => configuration.providers.oauth.google.enabled,
      secretsCheck: () => everyEnvironmentHasEnvKeys(config, ['OAUTH_GOOGLE_CLIENT_ID']),
      secretsCheckForEnvironment: (environmentName) =>
        environmentHasGuideKeys(environmentName, ['OAUTH_GOOGLE_CLIENT_ID']),
      instructionsForEnvironment: buildGoogleGuideInstructionsForEnvironment,
      browserUrlsForEnvironment: () => ['https://console.cloud.google.com/apis/credentials'],
      browserUrls: [],
      instructions: [
        'Create one OAuth client per environment in Google Cloud Console.',
        'With multiple environments, setup runs all providers for development first, then production.',
      ],
    },
    {
      providerName: 'GitHub App (sign-in)',
      scope: 'per-environment',
      enabledCheck: (configuration) => configuration.providers.oauth.github.enabled,
      secretsCheck: () => githubAppWithOauthGuideConfigured(config),
      secretsCheckForEnvironment: (environmentName) =>
        environmentHasGuideKeys(environmentName, [
          'OAUTH_GITHUB_CLIENT_ID',
          'OAUTH_GITHUB_CLIENT_SECRET',
        ]),
      instructionsForEnvironment: buildGithubGuideInstructionsForEnvironment,
      browserUrls: [],
      instructions: [
        'Credentials live in each .env.<environment> — not in .setup-credentials.',
        'With multiple environments, setup runs all providers for development first, then production.',
        'Use SETUP_INFRA_GITHUB_OAUTH_PASTE_ONLY=1 at apply to skip the browser manifest.',
      ],
    },
    {
      providerName: 'PostHog',
      enabledCheck: (configuration) => configuration.providers.posthog.enabled,
      secretsCheck: () => posthogGuideConfigured(),
      browserUrls: ['https://us.posthog.com/settings/user-api-keys'],
      secretPrompts: [
        { key: 'POSTHOG_PERSONAL_API_KEY', label: 'PostHog personal API key (phx_…)' },
      ],
      instructions: [
        '1. Log in to PostHog (open the link below when ready — it is copied to your clipboard)',
        '2. Settings → Personal API keys → "Create personal API key" → scopes: "All access"',
        '3. Copy the key (starts with phx_...)',
        '4. Paste it below when prompted (input is hidden) — it is saved to .setup-credentials for you.',
        `   Setup then reuses (or creates) projects named ${config.environments
          .map((environment) => `"${productResourceName(config, environment.name)}"`)
          .join(', ')} under org "${config.project.organization}"`,
        '   and writes POSTHOG_KEY + POSTHOG_HOST into each .env.<environment>.',
        '   Optional: POSTHOG_PROJECT_API_KEY=phc_… in each .env skips API project creation.',
        '   On 403 at apply: paste phc_… per environment — continue / skip / abort per env.',
      ],
    },
    {
      providerName: 'Cloudflare Turnstile',
      enabledCheck: (configuration) => configuration.providers.turnstile.enabled,
      secretsCheck: (secrets) =>
        isSecretFilled(secrets.cloudflare.apiToken) && isSecretFilled(secrets.cloudflare.accountId),
      browserUrls: ['https://dash.cloudflare.com/profile/api-tokens'],
      instructions: [
        '1. Log in to Cloudflare and open the API Tokens page (link is on your clipboard)',
        '2. Create Token → Custom token → permission "Turnstile : Edit" → Continue → Create',
        '3. Copy the token. Also copy your Account ID (any domain → Overview → right sidebar)',
        '4. Paste both below when prompted (input is hidden) — saved to .setup-credentials for you.',
        `   Setup then CREATES one widget per environment (${config.project.name}-<env>) and writes`,
        '   CAPTCHA_PROVIDER/SITE_KEY/SECRET into each .env.<environment> — no manual widget needed.',
      ],
      secretPrompts: [
        { key: 'CLOUDFLARE_API_TOKEN', label: 'Cloudflare API token (Turnstile:Edit)' },
        { key: 'CLOUDFLARE_ACCOUNT_ID', label: 'Cloudflare Account ID' },
      ],
    },
    {
      providerName: 'Railway',
      enabledCheck: (configuration) => configuration.providers.railway.enabled,
      secretsCheck: (secrets) => isSecretFilled(secrets.railway.apiToken),
      browserUrls: ['https://railway.com/account/tokens'],
      secretPrompts: [{ key: 'RAILWAY_API_TOKEN', label: 'Railway account token' }],
      instructions: [
        '1. Log in to Railway (or sign up at railway.app)',
        '2. You will land on the "Tokens" page',
        '3. Click "Create Token"',
        `4. Name it: ${config.project.name}-setup`,
        '5. Copy the token',
        `6. In ${secretsPath} set: RAILWAY_API_TOKEN=<paste-here>`,
        '',
        '7. Save the file',
      ],
    },
    {
      providerName: 'GitHub (token for setting repo/env secrets)',
      enabledCheck: (configuration) => configuration.providers.github.enabled,
      secretsCheck: () => hasGithubToken(),
      browserUrls: ['https://github.com/settings/tokens'],
      instructions: [
        '1. Log in to GitHub',
        '2. Go to Settings → Developer settings → Personal access tokens',
        '3. Generate new token (classic) with scopes: repo, admin:repo_hook (or use fine-grained with repo + secrets)',
        `4. In ${secretsPath} set: GITHUB_TOKEN=<paste-here>`,
        '',
        '5. Save the file (required for writing secrets to GitHub Environments)',
      ],
    },
    {
      providerName: 'Postman',
      enabledCheck: (configuration) => configuration.providers.postman.enabled,
      secretsCheck: (secrets) => isSecretFilled(secrets.postman.apiKey),
      browserUrls: ['https://go.postman.co/settings/me/api-keys'],
      secretPrompts: [{ key: 'POSTMAN_API_KEY', label: 'Postman API key (PMAK-…)' }],
      instructions: [
        '1. Log in to Postman (any plan — a personal key is fine)',
        '2. Settings → API Keys → Generate API Key',
        `3. Name it: ${config.project.name}-setup`,
        '4. Copy the key (PMAK-…)',
        `5. In ${secretsPath} set: POSTMAN_API_KEY=<paste-here>`,
        '',
        `6. Save the file. setup:infra creates a workspace named "${config.project.name}",`,
        '   uploads the collection, and writes POSTMAN_WORKSPACE_ID into each .env.<environment>.',
      ],
    },
    {
      providerName: 'Scalar',
      enabledCheck: (configuration) => configuration.providers.scalar.enabled,
      secretsCheck: (secrets) => isSecretFilled(secrets.scalar.apiKey),
      browserUrls: ['https://dashboard.scalar.com'],
      secretPrompts: [{ key: 'SCALAR_API_KEY', label: 'Scalar API key' }],
      instructions: [
        '1. Log in to the Scalar dashboard',
        '2. Settings → API Keys → create a key',
        '3. Copy the key',
        `4. In ${secretsPath} set: SCALAR_API_KEY=<paste-here>`,
        '',
        `5. Save the file. setup:infra publishes the OpenAPI doc to your team's registry`,
        `   (slug "${config.project.name}"); the namespace is auto-resolved from the token.`,
        '   Optional: pin SCALAR_NAMESPACE / SCALAR_SLUG in .setup-credentials for multi-team accounts.',
      ],
    },
  ];

  return steps;
}

async function runGuideStep(
  config: SetupConfig,
  step: GuideStepDefinition,
  initialSecrets: ReturnType<typeof reloadSecrets>,
  currentStep: number,
  totalSteps: number,
  environmentName?: string,
): Promise<ReturnType<typeof reloadSecrets>> {
  // Local mutable copy — the guide re-reads secrets from disk after the user pastes values.
  let secrets = initialSecrets;
  const stepLabel = environmentName
    ? `${step.providerName} · ${environmentName}`
    : step.providerName;
  const configured =
    step.scope === 'per-environment' && environmentName && step.secretsCheckForEnvironment
      ? step.secretsCheckForEnvironment(environmentName)
      : step.secretsCheck(secrets);

  if (configured) {
    logger.success(`Step ${currentStep}/${totalSteps} — ${stepLabel} — already configured`);
    return secrets;
  }

  logger.stepHeader(currentStep, totalSteps, stepLabel);

  const browserUrls =
    environmentName && step.browserUrlsForEnvironment
      ? step.browserUrlsForEnvironment(config, environmentName)
      : step.browserUrls;
  const [primaryUrl, ...otherUrls] = browserUrls;
  if (primaryUrl) {
    openBrowser(primaryUrl);
    if (clipboardAvailable() && copyToClipboard(primaryUrl)) {
      logger.success('🔗 Link copied to your clipboard — just paste it in the browser:');
      logger.info(`     ${primaryUrl}`);
    } else {
      logger.info(`Open this link: ${primaryUrl}`);
    }
  }
  for (const url of otherUrls) {
    logger.info(`Also opening: ${url}`);
    openBrowser(url);
  }

  const instructions =
    environmentName && step.instructionsForEnvironment
      ? step.instructionsForEnvironment(config, environmentName)
      : step.instructions;
  logger.instruction(instructions);

  if (step.secretPrompts && step.secretPrompts.length > 0 && process.stdin.isTTY) {
    for (const { key, label } of step.secretPrompts) {
      if (isSecretFilled(getEnvSetupValue(key))) {
        logger.success(`  ${key} — already set, skipping`);
        continue;
      }
      const value = await questionHidden(`  ${label} [hidden, paste & Enter]: `);
      if (value) {
        setEnvSetupVariable(key, value);
        logger.success(`  ✓ ${key} saved to .setup-credentials (input hidden)`);
      } else {
        logger.warn(`  ${key} left empty — set it later in ${getSecretsPath()}`);
      }
    }
  } else {
    await waitForEnter('  Press Enter when done...');
  }

  secrets = reloadSecrets(config);

  const doneAfterStep =
    step.scope === 'per-environment' && environmentName && step.secretsCheckForEnvironment
      ? step.secretsCheckForEnvironment(environmentName)
      : step.secretsCheck(secrets);

  if (doneAfterStep) {
    logger.success(`${stepLabel} — configured`);
  } else {
    logger.warn(`${stepLabel} — some values still empty (you can fill them later)`);
  }

  return secrets;
}

export async function runGuide(
  config: SetupConfig,
  activeEnvironments?: readonly string[],
): Promise<void> {
  if (ensureEnvSetupTemplate(config)) {
    throw new SetupAbort(
      'Generated .setup/.setup-credentials template. Fill the values (see URLs in the file), then run pnpm setup:infra again.',
    );
  }

  const steps = buildGuideSteps(config);
  const enabledSteps = steps.filter((step) => step.enabledCheck(config));
  // Environment scope is decided ONCE by the orchestrator and passed in — the guide never re-asks.
  const environmentNames = activeEnvironments
    ? [...activeEnvironments]
    : config.environments.map((environment) => environment.name);
  const accountSteps = enabledSteps.filter((step) => step.scope !== 'per-environment');
  const perEnvironmentSteps = enabledSteps.filter((step) => step.scope === 'per-environment');
  const perEnvironmentGuidePasses = environmentNames.length * perEnvironmentSteps.length;
  const totalSteps = accountSteps.length + perEnvironmentGuidePasses + 1; // +1 for CLI auth step

  let secrets = reloadSecrets(config);
  let currentStep = 0;

  for (const step of accountSteps) {
    currentStep += 1;
    secrets = await runGuideStep(config, step, secrets, currentStep, totalSteps);
  }

  if (perEnvironmentSteps.length > 0 && environmentNames.length > 0) {
    const multipleEnvironments = environmentNames.length > 1;
    if (multipleEnvironments) {
      logger.blank();
      logger.info(`Guide runs per-environment steps in order: ${environmentNames.join(' → ')}.`);
    }
    for (const environmentName of environmentNames) {
      if (multipleEnvironments) {
        logger.blank();
        logger.info(`══════════════════════════════════════════════════════════`);
        logger.info(`  Environment: ${environmentName}`);
        logger.info(`══════════════════════════════════════════════════════════`);
      }
      for (const step of perEnvironmentSteps) {
        currentStep += 1;
        secrets = await runGuideStep(
          config,
          step,
          secrets,
          currentStep,
          totalSteps,
          environmentName,
        );
      }
    }
  }

  // GitHub auth: token in .setup/.setup-credentials is enough (no CLI login required)
  currentStep = totalSteps;
  const needsGithubAuth = config.providers.github.enabled;

  if (needsGithubAuth) {
    if (hasGithubToken()) {
      logger.success(
        `Step ${currentStep}/${totalSteps} — GitHub — using GITHUB_TOKEN from .setup/.setup-credentials (no login required)`,
      );
    } else {
      logger.stepHeader(currentStep, totalSteps, 'CLI Authentication (GitHub)');
      logger.info('Checking GitHub CLI authentication...');
      try {
        execSync('gh auth status', { stdio: 'pipe', encoding: 'utf-8' });
        logger.success('GitHub CLI — already authenticated');
      } catch {
        logger.info('Opening GitHub login...');
        try {
          execSync('gh auth login', { stdio: 'inherit' });
          logger.success('GitHub CLI — authenticated');
        } catch {
          logger.warn(
            'GitHub login failed — you can set GITHUB_TOKEN in .setup/.setup-credentials or run "gh auth login" later',
          );
        }
      }
    }
  }

  logger.blank();
  logger.success('Guide complete — all API keys collected.');
  logger.info('Proceeding to automated provisioning...');
  logger.blank();
}
