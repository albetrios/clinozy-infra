/**
 * GitHub sign-in provider for `pnpm setup:infra` — backed by a GitHub **App** (not an OAuth App).
 *
 * GitHub Apps can be created programmatically via the App Manifest flow, so setup CREATES the app
 * (one browser click) and captures its `client_id` + `client_secret` — no manual copy-paste. A
 * GitHub App's client_id/secret drive the same "Sign in with GitHub" OAuth flow clinozy-be already
 * uses (the token is used once to fetch identity), so nothing in the backend changes. If the
 * manifest flow is unavailable (headless/CI, or it fails), setup falls back to a guided paste.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only, never printed to the console; setup secret files
 * are gitignored and written owner-only. See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import * as logger from '@setup/common/logger.js';
import type {
  InfraProvider,
  InfraProviderContext,
  ProviderResult,
  SetupConfig,
} from '@setup/common/types.js';
import { createGithubAppViaManifest } from '@setup/github/create-github-app.js';
import {
  assertCredentialCollectionNotAborted,
  backendOriginForEnvironment,
  everyEnvironmentHasEnvKeys,
  formatEnvCredentialCollectionSummary,
  oauthCallbackUrl,
  type CollectEnvCredentialsResult,
} from '@setup/envs/env-file-setup.util.js';
import { collectEnvCredentialsForContext } from '@setup/envs/collect-env-credentials-for-context.js';
import { readEnvFileValue, upsertEnvFileValue } from '@setup/envs/read-env-file.js';

/**
 * The GitHub OAuth callback for an env: the SPA's `<frontend origin>/callback/github` page, which
 * forwards code+state to the backend for the token exchange (see {@link oauthCallbackUrl}).
 */
function githubCallbackUrl(config: SetupConfig, environmentName: string): string {
  return oauthCallbackUrl(config, environmentName, 'github');
}

function buildGithubAppGuideInstructions(
  config: SetupConfig,
  environmentNames?: string[],
): string[] {
  // Scope to the environment(s) this step is actually running for (per-env traversal passes a
  // single env), so a "· development" step doesn't also print the production walkthrough.
  const environments =
    environmentNames && environmentNames.length > 0
      ? config.environments.filter((environment) => environmentNames.includes(environment.name))
      : config.environments;

  const lines: string[] = [
    'Credentials live in each .env.<environment> — configure one environment at a time at apply',
    '(continue / skip / abort per env).',
    'Recommended — paste only, no browser: SETUP_INFRA_GITHUB_OAUTH_PASTE_ONLY=1 (or pre-fill .env files).',
    '',
  ];

  for (const environment of environments) {
    const environmentName = environment.name;
    const callbackUrl =
      githubCallbackUrl(config, environmentName) || 'https://<your-frontend>/callback/github';
    lines.push(`--- ${environmentName} → .env.${environmentName} ---`);
    lines.push('1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App');
    lines.push(
      `2. Callback URL (the SPA's /callback/github page, NOT the backend API — exact): ${callbackUrl}`,
    );
    lines.push('3. Enable user authorization (OAuth); copy Client ID + Client secret');
    lines.push(
      `4. Paste at apply (or pre-fill): OAUTH_GITHUB_CLIENT_ID, OAUTH_GITHUB_CLIENT_SECRET,`,
    );
    lines.push(`   OAUTH_GITHUB_REDIRECT_URI=${callbackUrl}`);
    lines.push('');
  }

  lines.push(
    'Optional: without paste-only, setup may open a browser once at apply to create one shared app',
    'via the manifest flow (all callback URLs). Stale OAUTH_GITHUB_* values are replaced on failure.',
  );

  return lines;
}

type GithubOauthProbe = 'valid' | 'invalid' | 'unverified' | 'unreachable';

/**
 * Live-validate a GitHub OAuth App's Client ID + Secret by authenticating the *app itself*
 * against `POST /applications/{client_id}/token` with HTTP Basic auth (client_id:secret).
 *
 * @remarks
 * **Algorithm:** a deliberately invalid probe token is sent — GitHub authenticates the app
 * via Basic auth before looking at the token, so the status reveals the credentials:
 * `401`/`403` ⇒ the Client ID/Secret are wrong (`invalid`); `404`/`422` ⇒ the app
 * authenticated and only the probe token is bad, so the credentials are good (`valid`).
 * **Side effects:** one outbound HTTPS request to api.github.com; never throws.
 */
async function probeGithubOauthCredentials(
  clientId: string,
  clientSecret: string,
): Promise<GithubOauthProbe> {
  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch(`https://api.github.com/applications/${clientId}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'clinozy-be-setup',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ access_token: 'setup-github-app-probe' }),
    });
    if (response.status === 401 || response.status === 403) return 'invalid';
    // Basic auth succeeded — probe token is missing/invalid (404) or malformed (422).
    if (response.status === 404 || response.status === 422) return 'valid';
    return 'unverified';
  } catch {
    return 'unreachable';
  }
}

function hasCompleteGithubOauthConfig(config: SetupConfig): boolean {
  return everyEnvironmentHasEnvKeys(config, [
    'OAUTH_GITHUB_CLIENT_ID',
    'OAUTH_GITHUB_CLIENT_SECRET',
  ]);
}

async function validateGithubOauth(context: InfraProviderContext): Promise<ProviderResult> {
  if (!context.config.providers.oauth.github.enabled) {
    return { success: true, message: 'GitHub OAuth: skipped (disabled)' };
  }

  logger.info('Validating GitHub OAuth credentials from .env.<environment>...');
  let allValid = true;
  for (const environmentName of context.environments) {
    const clientId = readEnvFileValue(environmentName, 'OAUTH_GITHUB_CLIENT_ID');
    const clientSecret = readEnvFileValue(environmentName, 'OAUTH_GITHUB_CLIENT_SECRET');

    // Missing creds are a warning (you may fill them later), not a hard failure.
    if (!(clientId && clientSecret)) {
      logger.warn(
        `  GitHub OAuth for "${environmentName}" — not fully configured in .env.${environmentName} (need OAUTH_GITHUB_CLIENT_ID + _CLIENT_SECRET)`,
      );
      continue;
    }

    const probe = await probeGithubOauthCredentials(clientId, clientSecret);
    if (probe === 'valid') {
      logger.success(
        `  GitHub OAuth for "${environmentName}" — credentials verified against GitHub`,
      );
    } else if (probe === 'invalid') {
      logger.error(
        `  GitHub OAuth for "${environmentName}" — GitHub rejected these credentials (HTTP 401). Check OAUTH_GITHUB_CLIENT_ID / _CLIENT_SECRET.`,
      );
      allValid = false;
    } else if (probe === 'unreachable') {
      logger.warn(
        `  GitHub OAuth for "${environmentName}" — could not reach GitHub to validate (offline?).`,
      );
    } else {
      logger.warn(
        `  GitHub OAuth for "${environmentName}" — credentials set, but GitHub could not confirm them remotely.`,
      );
    }
  }
  return allValid
    ? { success: true, message: 'GitHub OAuth: credentials validated' }
    : {
        success: false,
        message: 'GitHub OAuth: one or more environments have invalid credentials',
      };
}

function githubOauthPasteOnly(): boolean {
  const value = process.env.SETUP_INFRA_GITHUB_OAUTH_PASTE_ONLY?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function githubOauthUsesManifest(): boolean {
  // The manifest flow creates ONE GitHub App covering every environment's callback URL (it reads
  // config.environments, not the per-step context), so it runs regardless of whether this step is
  // processing one env or all of them. Under per-environment traversal the first env that needs it
  // creates the app and writes creds into every .env.<environment>; later envs then see complete,
  // valid config and simply validate — no duplicate apps, no forced paste. Paste-only opt-out
  // (SETUP_INFRA_GITHUB_OAUTH_PASTE_ONLY=1) still forces manual entry.
  return !githubOauthPasteOnly();
}

/** Fallback: prompt for the GitHub App's client_id/secret at stdin (when the manifest flow can't run). */
async function pasteGithubCredentials(
  context: InfraProviderContext,
): Promise<CollectEnvCredentialsResult> {
  return collectEnvCredentialsForContext(context, {
    providerName: 'GitHub App',
    scope: 'per-environment',
    fields: [
      { key: 'OAUTH_GITHUB_CLIENT_ID', label: 'Client ID (Iv1.… / github_app client id)' },
      { key: 'OAUTH_GITHUB_CLIENT_SECRET', label: 'Client Secret', secret: true },
      {
        key: 'OAUTH_GITHUB_REDIRECT_URI',
        label: 'Redirect URI',
        defaultValue: (config, environmentName) => githubCallbackUrl(config, environmentName),
      },
    ],
  });
}

/** Create the GitHub App via the manifest flow and write its credentials into every env file. */
async function provisionGithubApp(context: InfraProviderContext): Promise<boolean> {
  const callbackUrls = context.config.environments
    .map((environment) => githubCallbackUrl(context.config, environment.name))
    .filter(Boolean);
  if (callbackUrls.length === 0) {
    logger.warn(
      '  GitHub App: no frontend origin configured (set frontend.url.<env>) — falling back to paste.',
    );
    return false;
  }
  const homepageUrl = backendOriginForEnvironment(
    context.config,
    context.config.environments[0]?.name ?? 'development',
  );
  try {
    const app = await createGithubAppViaManifest({
      name: `${context.config.project.displayName} sign-in`,
      homepageUrl,
      callbackUrls,
    });
    for (const environment of context.config.environments) {
      const redirectUri = githubCallbackUrl(context.config, environment.name);
      upsertEnvFileValue(environment.name, 'OAUTH_GITHUB_CLIENT_ID', app.clientId);
      upsertEnvFileValue(environment.name, 'OAUTH_GITHUB_CLIENT_SECRET', app.clientSecret);
      if (redirectUri)
        upsertEnvFileValue(environment.name, 'OAUTH_GITHUB_REDIRECT_URI', redirectUri);
    }
    logger.success(
      `  GitHub App "${app.slug}" created — credentials written to .env.<environment>.`,
    );
    return true;
  } catch (error) {
    logger.warn(
      `  GitHub App auto-create unavailable (${error instanceof Error ? error.message : String(error)}) — falling back to paste.`,
    );
    return false;
  }
}

export const setupGithubAppWithOauthProvider: InfraProvider = {
  key: 'github-app-with-oauth',
  // The redirect URI is a pure function of the SPA origin, so it is derived on every run instead of
  // keeping a pasted value that goes stale on a rename (client id/secret stay user-entered).
  toEnvironmentVariables: ({ config }, environmentName) => {
    const redirectUri = config.providers.oauth.github.enabled
      ? githubCallbackUrl(config, environmentName)
      : '';
    return redirectUri ? { OAUTH_GITHUB_REDIRECT_URI: redirectUri } : {};
  },
  name: 'GitHub App (sign-in)',
  isEnabled: ({ config }) => config.providers.oauth.github.enabled,
  disabledReason: () => 'GitHub OAuth disabled in setup.config.json',
  preview: ({ config }) =>
    config.providers.oauth.github.enabled
      ? {
          detail: 'Paste per .env.<environment> (or optional manifest create at apply)',
          url: 'https://github.com/settings/apps/new',
          configKey: '.env.<environment> → OAUTH_GITHUB_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI',
        }
      : null,
  settingsReview: ({ config }) =>
    config.providers.oauth.github.enabled
      ? [
          {
            bucket: 'extra',
            provider: 'GitHub App',
            detail: 'paste per env (optional manifest at apply)',
          },
        ]
      : [],
  describe: ({ environments }) => ({ environments }),
  inspectRemote: async ({ config }) => ({
    present: false,
    fields: [],
    error: config.providers.oauth.github.enabled
      ? 'paste per .env.<environment> at apply (optional manifest auto-create without SETUP_INFRA_GITHUB_OAUTH_PASTE_ONLY)'
      : 'GitHub OAuth disabled in setup.config.json',
  }),
  buildStep: (context: InfraProviderContext) => ({
    name: 'GitHub App (sign-in)',
    enabled: setupGithubAppWithOauthProvider.isEnabled(context),
    enabledReason: setupGithubAppWithOauthProvider.disabledReason(context),
    instructions: buildGithubAppGuideInstructions(context.config, context.environments),
    execute: async () => {
      if (hasCompleteGithubOauthConfig(context.config)) {
        const existing = await validateGithubOauth(context);
        if (existing.success) return existing;
        logger.warn(
          githubOauthPasteOnly()
            ? '  GitHub rejected the OAUTH_GITHUB_* values in .env.<environment> — paste replacement credentials per environment.'
            : '  GitHub rejected the OAUTH_GITHUB_* values in .env.<environment> — creating a new GitHub App to replace them.',
        );
      } else if (everyEnvironmentHasEnvKeys(context.config, ['OAUTH_GITHUB_CLIENT_ID'])) {
        logger.warn(
          '  OAUTH_GITHUB_CLIENT_ID is set but OAUTH_GITHUB_CLIENT_SECRET is missing in one or more env files — creating via manifest (or paste).',
        );
      }

      let pasteSummary: CollectEnvCredentialsResult | undefined;
      if (githubOauthUsesManifest()) {
        const created = await provisionGithubApp(context);
        if (!created) {
          pasteSummary = await pasteGithubCredentials(context);
          assertCredentialCollectionNotAborted(pasteSummary);
        }
      } else {
        if (githubOauthPasteOnly()) {
          logger.info(
            '  GitHub App: SETUP_INFRA_GITHUB_OAUTH_PASTE_ONLY=1 — skipping browser manifest.',
          );
        }
        pasteSummary = await pasteGithubCredentials(context);
        assertCredentialCollectionNotAborted(pasteSummary);
      }

      const result = await validateGithubOauth(context);
      if (!result.success) throw new Error(result.message);
      if (pasteSummary) {
        return {
          ...result,
          message: formatEnvCredentialCollectionSummary(result.message, pasteSummary),
        };
      }
      return result;
    },
  }),
};
