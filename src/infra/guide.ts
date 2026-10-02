import { execSync } from 'node:child_process';
import * as logger from '@setup/common/logger.js';
import {
  NETLIFY_LOGIN_COMMAND,
  credentialUrl,
  getEnvSetupValue,
  hasGithubToken,
  isSecretFilled,
  reloadSecrets,
  setEnvSetupVariable,
} from '@setup/common/secrets.js';
import { questionHidden } from '@setup/common/prompts.js';
import { isNonInteractiveRun, oauthCallbackUrl } from '@setup/envs/env-file-setup.util.js';
import { readEnvFileValue } from '@setup/envs/read-env-file.js';
import { posthogGuideConfigured } from '@setup/infra/providers/setup-posthog/setup-posthog.provider.js';
import type { SetupConfig } from '@setup/common/types.js';

/**
 * The credentials guide: before provisioning, ask once — in one pass — for every value missing from
 * `.setup/.setup-credentials`, with the page to get it from, and save each answer there. Nothing that
 * is already set (or satisfied another way, e.g. a CLI login) is asked. Per-environment values are
 * saved as `KEY__<environment>`; setup writes them into each app's `.env.<environment>`. (GitHub
 * sign-in is handled by its provider at apply: it creates the GitHub App, or asks for its keys.)
 */

interface GuidePrompt {
  /** Key in `.setup-credentials`; per-environment steps save it as `KEY__<environment>`. */
  key: string;
  /** A few words on what to paste. */
  label: string;
  optional?: boolean;
}

interface GuideStep {
  providerName: string;
  /** The provider keys (`infra.config.ts`) that need these values — the step runs only for them. */
  providers: readonly string[];
  enabledCheck: (config: SetupConfig) => boolean;
  scope?: 'account' | 'per-environment';
  /** True when nothing needs asking — the values are set, or satisfied another way. */
  configured: (secrets: ReturnType<typeof reloadSecrets>, environmentName?: string) => boolean;
  /** Where to create the values (defaults to the first prompt's `.setup-credentials` link). */
  url?: (environmentName?: string) => string;
  /** One short extra line, e.g. the redirect URI to register. */
  note?: (environmentName: string) => string;
  prompts: GuidePrompt[];
}

/** `gh auth status` passes — the GitHub CLI's own login stands in for GITHUB_TOKEN. */
function ghCliAuthenticated(): boolean {
  try {
    execSync('gh auth status', { stdio: 'pipe', encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

const credentialKey = (prompt: GuidePrompt, environmentName?: string): string =>
  environmentName ? `${prompt.key}__${environmentName}` : prompt.key;

/** A per-environment value is known when the env file has it or `.setup-credentials` has `KEY__<env>`. */
function environmentValueKnown(environmentName: string, key: string): boolean {
  return (
    isSecretFilled(readEnvFileValue(environmentName, key)) ||
    isSecretFilled(getEnvSetupValue(`${key}__${environmentName}`))
  );
}

const promptKnown = (prompt: GuidePrompt, environmentName?: string): boolean =>
  environmentName
    ? environmentValueKnown(environmentName, prompt.key)
    : isSecretFilled(getEnvSetupValue(prompt.key));

const everyRequiredKnown =
  (prompts: () => GuidePrompt[]) =>
  (_secrets: unknown, environmentName?: string): boolean =>
    prompts()
      .filter((prompt) => !prompt.optional)
      .every((prompt) => promptKnown(prompt, environmentName));

export function buildGuideSteps(config: SetupConfig): GuideStep[] {
  const stripePrompts: GuidePrompt[] = [
    { key: 'STRIPE_SECRET_KEY', label: 'secret key (sk_test_… / sk_live_… in production)' },
    { key: 'STRIPE_PUBLISHABLE_KEY', label: 'publishable key (pk_…)' },
    {
      key: 'STRIPE_WEBHOOK_SECRET',
      label: 'webhook signing secret (whsec_…, Developers → Webhooks)',
    },
  ];
  const googlePrompts: GuidePrompt[] = [
    { key: 'OAUTH_GOOGLE_CLIENT_ID', label: 'Web client ID (….apps.googleusercontent.com)' },
    { key: 'OAUTH_GOOGLE_CLIENT_SECRET', label: 'client secret (GOCSPX-…)' },
  ];
  return [
    {
      providerName: 'Neon Postgres',
      providers: ['neon'],
      enabledCheck: (configuration) => configuration.providers.neon.enabled,
      configured: (secrets) => isSecretFilled(secrets.neon.apiKey),
      prompts: [
        { key: 'NEON_API_KEY', label: 'API key (napi_…)' },
        {
          key: 'NEON_ORG_ID',
          label: 'org ID, if your key belongs to an organization',
          optional: true,
        },
      ],
    },
    {
      providerName: 'AWS IAM',
      providers: ['aws'],
      enabledCheck: (configuration) => configuration.providers.aws.enabled,
      configured: (secrets) =>
        isSecretFilled(secrets.aws.accessKeyId) && isSecretFilled(secrets.aws.secretAccessKey),
      prompts: [
        {
          key: 'AWS_ACCESS_KEY_ID',
          label: 'access key of a user with AmazonS3FullAccess + IAMFullAccess',
        },
        { key: 'AWS_SECRET_ACCESS_KEY', label: 'its secret access key' },
      ],
    },
    {
      providerName: 'Sentry',
      providers: ['sentry'],
      enabledCheck: (configuration) => configuration.providers.sentry.enabled,
      configured: (secrets) => isSecretFilled(secrets.sentry.authToken),
      prompts: [{ key: 'SENTRY_AUTH_TOKEN', label: 'auth token, scopes project:admin/write/read' }],
    },
    {
      providerName: 'Resend',
      providers: ['resend'],
      enabledCheck: (configuration) => configuration.providers.resend.enabled,
      configured: (secrets) => isSecretFilled(secrets.resend.apiKey),
      prompts: [{ key: 'RESEND_API_KEY', label: 'API key, full access (re_…)' }],
    },
    {
      providerName: 'PostHog',
      providers: ['posthog'],
      enabledCheck: (configuration) => configuration.providers.posthog.enabled,
      configured: () => posthogGuideConfigured(),
      prompts: [{ key: 'POSTHOG_PERSONAL_API_KEY', label: 'personal API key, all access (phx_…)' }],
    },
    {
      providerName: 'Cloudflare Turnstile',
      providers: ['turnstile'],
      enabledCheck: (configuration) => configuration.providers.turnstile.enabled,
      configured: (secrets) =>
        isSecretFilled(secrets.cloudflare.apiToken) && isSecretFilled(secrets.cloudflare.accountId),
      prompts: [
        { key: 'CLOUDFLARE_API_TOKEN', label: 'API token with Turnstile:Edit' },
        { key: 'CLOUDFLARE_ACCOUNT_ID', label: 'account ID (any domain → Overview sidebar)' },
      ],
    },
    {
      providerName: 'Railway',
      providers: ['railway', 'railway-redis'],
      enabledCheck: (configuration) => configuration.providers.railway.enabled,
      configured: (secrets) => isSecretFilled(secrets.railway.apiToken),
      prompts: [{ key: 'RAILWAY_API_TOKEN', label: 'account token' }],
    },
    {
      providerName: 'GitHub',
      providers: ['github'],
      enabledCheck: (configuration) => configuration.providers.github.enabled,
      configured: () => hasGithubToken() || ghCliAuthenticated(),
      prompts: [{ key: 'GITHUB_TOKEN', label: 'token with repo + environment-secrets access' }],
    },
    {
      providerName: 'Postman',
      providers: ['postman'],
      enabledCheck: (configuration) => configuration.providers.postman.enabled,
      configured: (secrets) => isSecretFilled(secrets.postman.apiKey),
      prompts: [{ key: 'POSTMAN_API_KEY', label: 'API key (PMAK-…)' }],
    },
    {
      providerName: 'Scalar',
      providers: ['scalar'],
      enabledCheck: (configuration) => configuration.providers.scalar.enabled,
      configured: (secrets) => isSecretFilled(secrets.scalar.apiKey),
      prompts: [{ key: 'SCALAR_API_KEY', label: 'API key' }],
    },
    {
      providerName: 'Stripe',
      providers: ['stripe'],
      scope: 'per-environment',
      enabledCheck: (configuration) => configuration.providers.stripe.enabled,
      configured: everyRequiredKnown(() => stripePrompts),
      url: (environmentName) =>
        config.environments.find((environment) => environment.name === environmentName)
          ?.nodeEnvironment === 'production'
          ? 'https://dashboard.stripe.com/apikeys'
          : 'https://dashboard.stripe.com/test/apikeys',
      prompts: stripePrompts,
    },
    {
      providerName: 'Google sign-in',
      providers: ['google-oauth'],
      scope: 'per-environment',
      enabledCheck: (configuration) => configuration.providers.oauth.google.enabled,
      configured: everyRequiredKnown(() => googlePrompts),
      url: () => 'https://console.cloud.google.com/apis/credentials',
      note: (environmentName) =>
        `redirect URI to register: ${oauthCallbackUrl(config, environmentName, 'google') || '<frontend>/callback/google'}`,
      prompts: googlePrompts,
    },
  ];
}

/** Ask once (hidden input) for `key` and save it to `.setup-credentials`. True when a value was given. */
export async function askForValue(key: string, label: string, optional = false): Promise<boolean> {
  const value = (
    await questionHidden(`  ${key} — ${label}${optional ? ' (optional)' : ''}: `)
  ).trim();
  if (!value) return false;
  setEnvSetupVariable(key, value);
  logger.success(`  ${key} saved`);
  return true;
}

/** Ask for one step's missing values (hidden input) and save them. Returns how many stay missing. */
async function runGuideStep(
  step: GuideStep,
  secrets: ReturnType<typeof reloadSecrets>,
  environmentName?: string,
): Promise<number> {
  if (step.configured(secrets, environmentName)) return 0;
  const missing = step.prompts.filter((prompt) => !promptKnown(prompt, environmentName));
  if (missing.length === 0) return 0;
  const url = step.url?.(environmentName) ?? credentialUrl(missing[0]?.key ?? '') ?? '';
  const label = environmentName ? `${step.providerName} · ${environmentName}` : step.providerName;
  logger.blank();
  logger.info(`${label} — ${url}`);
  if (environmentName && step.note) logger.info(`  ${step.note(environmentName)}`);

  if (isNonInteractiveRun()) {
    logger.warn(
      `  Missing: ${missing.map((prompt) => credentialKey(prompt, environmentName)).join(', ')}`,
    );
    return missing.filter((prompt) => !prompt.optional).length;
  }
  let stillMissing = 0;
  for (const prompt of missing) {
    const given = await askForValue(
      credentialKey(prompt, environmentName),
      prompt.label,
      prompt.optional,
    );
    if (!given && !prompt.optional) stillMissing += 1;
  }
  return stillMissing;
}

/** The guide steps for enabled providers in this run (`selectedProviders` = the `--providers` scope). */
function selectedSteps(config: SetupConfig, selectedProviders?: ReadonlySet<string>): GuideStep[] {
  return buildGuideSteps(config).filter(
    (step) =>
      step.enabledCheck(config) &&
      (!selectedProviders || step.providers.some((key) => selectedProviders.has(key))),
  );
}

export interface CredentialStatus {
  /** `Stripe · production`, `Neon Postgres`, … */
  label: string;
  url: string;
  /** Required keys still missing from `.setup-credentials` (empty = complete). */
  missing: string[];
}

/** What each provider in this run needs from `.setup-credentials`, and what is still missing. */
export function credentialStatus(
  config: SetupConfig,
  environmentNames: readonly string[],
  selectedProviders?: ReadonlySet<string>,
): CredentialStatus[] {
  const secrets = reloadSecrets(config);
  return selectedSteps(config, selectedProviders).flatMap((step) =>
    (step.scope === 'per-environment' ? environmentNames : [undefined]).map((environmentName) => {
      const missing = step.configured(secrets, environmentName)
        ? []
        : step.prompts
            .filter((prompt) => !prompt.optional && !promptKnown(prompt, environmentName))
            .map((prompt) => credentialKey(prompt, environmentName));
      return {
        label: environmentName ? `${step.providerName} · ${environmentName}` : step.providerName,
        url: step.url?.(environmentName) ?? credentialUrl(step.prompts[0]?.key ?? '') ?? '',
        missing,
      };
    }),
  );
}

export async function runGuide(
  config: SetupConfig,
  activeEnvironments?: readonly string[],
  selectedProviders?: ReadonlySet<string>,
): Promise<void> {
  const steps = selectedSteps(config, selectedProviders);
  // Environment scope is decided ONCE by the orchestrator and passed in — the guide never re-asks.
  const environmentNames = activeEnvironments
    ? [...activeEnvironments]
    : config.environments.map((environment) => environment.name);

  const secrets = reloadSecrets(config);
  const needsInput = steps.some((step) =>
    step.scope === 'per-environment'
      ? environmentNames.some((environmentName) => !step.configured(secrets, environmentName))
      : !step.configured(secrets),
  );
  if (needsInput) {
    logger.blank();
    logger.info(
      !isNonInteractiveRun()
        ? 'Some values are missing from .setup/.setup-credentials — paste each one (hidden; Enter skips). Saved for next time.'
        : 'Some values are missing from .setup/.setup-credentials (run without --yes, in a terminal, to be asked):',
    );
  }

  let stillMissing = 0;
  for (const step of steps.filter((entry) => entry.scope !== 'per-environment')) {
    stillMissing += await runGuideStep(step, reloadSecrets(config));
  }
  for (const environmentName of environmentNames) {
    for (const step of steps.filter((entry) => entry.scope === 'per-environment')) {
      stillMissing += await runGuideStep(step, reloadSecrets(config), environmentName);
    }
  }

  // GitHub: the token in .setup/.setup-credentials or the gh CLI's login; offer the login otherwise.
  const needsGithub =
    config.providers.github.enabled && (!selectedProviders || selectedProviders.has('github'));
  if (needsGithub && !hasGithubToken() && !ghCliAuthenticated() && !isNonInteractiveRun()) {
    logger.info('Opening GitHub login...');
    try {
      execSync('gh auth login', { stdio: 'inherit' });
      logger.success('GitHub CLI — authenticated');
    } catch {
      logger.warn('GitHub login failed — set GITHUB_TOKEN in .setup/.setup-credentials later');
    }
  }

  // Netlify: only the CLI login is used — there is no token to paste.
  const needsNetlify =
    config.providers.netlify?.enabled === true &&
    (!selectedProviders || selectedProviders.has('netlify'));
  if (needsNetlify && !reloadSecrets(config).netlify?.authToken) {
    logger.blank();
    logger.warn(
      `Netlify — not logged in on this machine. Run \`${NETLIFY_LOGIN_COMMAND}\` (opens the browser), then run setup again.`,
    );
    stillMissing += 1;
  }

  logger.blank();
  if (stillMissing > 0) {
    logger.warn(
      `${stillMissing} value(s) still missing — their providers will report it; run setup again to be asked.`,
    );
  } else {
    logger.success('Credentials complete.');
  }
  logger.info('Proceeding to automated provisioning...');
  logger.blank();
}
