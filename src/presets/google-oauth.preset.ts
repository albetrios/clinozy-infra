/**
 * Google OAuth preset (guide-only).
 *
 * Google exposes no API to create OAuth clients, so setup prints a step-by-step Google Cloud
 * Console walkthrough (one client per environment) and collects the values — from
 * `.setup/.setup-credentials` (`KEY__<environment>`) or pasted at the prompt — into each
 * `.env.<environment>`.
 */
import type { SetupConfig } from '@setup/common/types.js';
import {
  frontendOriginForEnvironment,
  oauthAppDisplayName,
  oauthCallbackUrl,
} from '@setup/envs/env-file-setup.util.js';
import type { GuidePreset } from './types.js';

function buildGoogleOauthGuideInstructions(config: SetupConfig): string[] {
  const projectName = config.project.name;
  const lines: string[] = [
    'No resource is created — create one Web-application OAuth client per environment in Google Cloud Console, then put its values in .setup/.setup-credentials; setup writes each `.env.<environment>`.',
    '',
  ];

  for (const environment of config.environments) {
    const environmentName = environment.name;
    const appName = oauthAppDisplayName(projectName, environmentName);
    // The redirect URI is the SPA's /callback/google page (FRONTEND origin): the browser lands
    // there with code+state and the SPA forwards them to the backend, which brokers the
    // code↔token exchange — the client secret never touches the browser.
    const frontendUrl = frontendOriginForEnvironment(config, environmentName);
    const callbackUrl =
      oauthCallbackUrl(config, environmentName, 'google') ||
      'https://<your-frontend>/callback/google';

    lines.push(`--- ${environmentName} → .env.${environmentName} ---`);
    lines.push('1. Pick or create a project: https://console.cloud.google.com/projectcreate');
    lines.push(
      '2. OAuth consent screen → External, then add your Google account under Test users — ' +
        'required while the app is in Testing, else sign-in fails with access_denied: ' +
        'https://console.cloud.google.com/auth/overview',
    );
    lines.push(
      '3. Credentials → Create Credentials → OAuth client ID → Application type: ' +
        'Web application (Desktop type will NOT work): https://console.cloud.google.com/apis/credentials',
    );
    lines.push(`4. Name: "${appName}"`);
    if (!frontendUrl) {
      lines.push(
        `5. Set frontend.url.${environmentName} (the SPA origin) in setup.config.json, then add this Authorized redirect URI (exact match — SPA origin + /callback/google): ${callbackUrl}`,
      );
    } else {
      lines.push(
        `5. Authorized redirect URI — paste EXACTLY (the SPA's /callback/google page, NOT the backend API): ${callbackUrl}`,
      );
    }
    lines.push(
      '6. Create, then copy the Client ID (ends .apps.googleusercontent.com) and Client Secret (starts GOCSPX-) right away — Google shows the secret only once (Download JSON)',
    );
    lines.push(
      '7. In .setup/.setup-credentials set (setup writes them, plus the redirect URI, into',
    );
    lines.push(`   .env.${environmentName}):`);
    lines.push(`   OAUTH_GOOGLE_CLIENT_ID__${environmentName}=….apps.googleusercontent.com`);
    lines.push(`   OAUTH_GOOGLE_CLIENT_SECRET__${environmentName}=…`);
    lines.push('');
  }

  lines.push(
    'When prompted, configure one environment at a time — skip any env you are not ready to set up yet.',
  );

  return lines;
}

export const googleOauthPreset: GuidePreset = {
  kind: 'guide',
  key: 'google-oauth',
  name: 'Google OAuth',
  isEnabled: ({ config }) => config.providers.oauth.google.enabled,
  disabledReason: () => 'Google OAuth disabled in setup.config.json',
  preview: {
    detail: 'Step-by-step OAuth client setup, one client per environment',
    url: 'https://console.cloud.google.com/apis/credentials',
    configKey: '.setup-credentials → OAUTH_GOOGLE_CLIENT_ID / _CLIENT_SECRET __<environment>',
  },
  settingsDetail: 'guide + validate per env file',
  perEnv: true,
  dashboard: {
    url: 'https://console.cloud.google.com/apis/credentials',
    label: 'Google Cloud → credentials',
  },
  steps: [
    'Open Google Cloud → APIs & Services → Credentials.',
    'Create an OAuth client (Application type: Web application) — one per environment.',
    'Add the redirect URI setup prints (SPA origin + /callback/google) to the client.',
    'Copy the Client ID and Client secret into .setup/.setup-credentials as OAUTH_GOOGLE_CLIENT_ID__<env> / OAUTH_GOOGLE_CLIENT_SECRET__<env>.',
  ],
  describe: ({ environments }) => ({ environments }),
  // Derived from the SPA origin on every run (client id/secret stay user-entered).
  toEnvironmentVariables: ({ config }, environmentName) => {
    const redirectUri = config.providers.oauth.google.enabled
      ? oauthCallbackUrl(config, environmentName, 'google')
      : '';
    return redirectUri ? { OAUTH_GOOGLE_REDIRECT_URI: redirectUri } : {};
  },
  outputs: [
    { key: 'OAUTH_GOOGLE_CLIENT_ID', description: 'Google OAuth client ID' },
    { key: 'OAUTH_GOOGLE_CLIENT_SECRET', description: 'Google OAuth client secret' },
    { key: 'OAUTH_GOOGLE_REDIRECT_URI', description: 'SPA OAuth redirect URI (/callback/google)' },
  ],
  instructions: ({ config }) => buildGoogleOauthGuideInstructions(config),
  guide: {
    scope: 'per-environment',
    guideError: 'guide-only — set OAUTH_GOOGLE_*__<environment> in .setup/.setup-credentials',
    summaryLine: 'Google OAuth: credentials written to .env.<environment>',
    fields: [
      { key: 'OAUTH_GOOGLE_CLIENT_ID', label: 'Client ID (….apps.googleusercontent.com)' },
      { key: 'OAUTH_GOOGLE_CLIENT_SECRET', label: 'Client Secret (GOCSPX-…)', secret: true },
      {
        key: 'OAUTH_GOOGLE_REDIRECT_URI',
        label: 'Redirect URI',
        defaultValue: (config: SetupConfig, environmentName: string) =>
          oauthCallbackUrl(config, environmentName, 'google'),
      },
    ],
  },
};
