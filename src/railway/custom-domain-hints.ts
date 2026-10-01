/**
 * Follow-up guidance printed after `pnpm setup:domain` attaches a custom domain to the API.
 *
 * Kept out of `custom-domain.ts` (a CLI that runs on import) so the wording is unit-testable.
 * The wording is the contract: an API domain changes where clients REACH the API, never the SPA
 * origin. The backend reads FRONTEND_URL as the SPA origin (reset/invite links, WebAuthn origin)
 * and ALLOWED_ORIGINS as the SPA origins allowed to call it — pointing either at the API domain
 * broke sign-in emails and passkeys, and `gh secret set ALLOWED_ORIGINS` with only the API host
 * replaced the whole CORS list.
 */

export interface DownstreamHintInput {
  environmentName: string;
  serviceName: string;
  domain: string;
  oauthGoogleEnabled: boolean;
  oauthGithubEnabled: boolean;
}

/** The lines to print, in order (`''` = blank line). Pure — no I/O. */
export function downstreamEnvHints(input: DownstreamHintInput): string[] {
  const origin = `https://${input.domain}`;
  const env = input.environmentName;
  return [
    `Next: point API clients for "${env}" at ${origin}.`,
    '',
    `  app.frontendUrl.${env} — set to ${origin} in setup.config.json (the API origin, despite the`,
    '                         name): Postman/Scalar servers and webhook URLs resolve against it',
    `  VITE_API_BASE_URL      — set to ${origin} in the frontend's .env.${env}`,
    '  FRONTEND_URL, ALLOWED_ORIGINS — no change: they name the SPA origin(s), not this API domain',
    ...(input.oauthGoogleEnabled || input.oauthGithubEnabled
      ? [
          '  OAUTH_*_REDIRECT_URI — no change: they point at the SPA (<frontend origin>/callback/<provider>)',
        ]
      : []),
    '',
    '  Copy-pasteable GitHub Environment update (run in the frontend repo):',
    `    gh secret set VITE_API_BASE_URL --env ${env} --body "${origin}"`,
    `  Or push the frontend's local env file with \`pnpm github:sync ${env}\` in that repo.`,
  ];
}
