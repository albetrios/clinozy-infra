/**
 * Cloudflare Turnstile provider for `pnpm setup:infra`.
 *
 * PROVISIONS Turnstile: with CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (from
 * `.setup/.setup-credentials`), it creates/adopts ONE widget per environment via the Cloudflare
 * API and writes `CAPTCHA_PROVIDER` / `CAPTCHA_SITE_KEY` / `CAPTCHA_SECRET` into each
 * `.env.<environment>`. The widget secret is only returned by Cloudflare on create/rotate, so a
 * secret already on file is kept (idempotent); a remote widget with no local secret is rotated.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only, never printed to the console; setup secret files
 * are gitignored and unreadable by the agent (deny-read guard). See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import { isSecretFilled } from '@setup/common/secrets.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import * as logger from '@setup/common/logger.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import type {
  InfraProvider,
  InfraProviderContext,
  ProviderResult,
  SetupConfig,
} from '@setup/common/types.js';
import {
  backendOriginForEnvironment,
  everyEnvironmentHasEnvKeys,
  frontendOriginForEnvironment,
  productResourceName,
} from '@setup/envs/env-file-setup.util.js';
import { readEnvFileValue, upsertEnvFileValue } from '@setup/envs/read-env-file.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens';

interface TurnstileWidget {
  sitekey: string;
  name: string;
  domains?: string[];
  mode?: string;
}

/** True when both lists hold the same hostnames, in any order. */
export function sameDomains(current: readonly string[], desired: readonly string[]): boolean {
  const left = new Set(current.map((domain) => domain.toLowerCase()));
  const right = new Set(desired.map((domain) => domain.toLowerCase()));
  return left.size === right.size && [...left].every((domain) => right.has(domain));
}
interface TurnstileWidgetWithSecret extends TurnstileWidget {
  secret: string;
}

/** Call the Cloudflare API and unwrap the `result`, throwing on `success:false`. */
async function cloudflareApi<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: string },
): Promise<T> {
  const response = await setupFetch({
    name: 'Cloudflare',
    url: `${CF_API_BASE}${path}`,
    init: {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(init?.body ? { body: init.body } : {}),
    },
  });
  const body = (await response.json()) as {
    success: boolean;
    errors?: Array<{ message: string }>;
    result: T;
  };
  if (!(response.ok && body.success)) {
    const detail =
      body.errors?.map((error) => error.message).join('; ') || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body.result;
}

/**
 * Widget name per env: ONE shared widget for backend + frontend, named `<product>-<env>`
 * (e.g. `clinozy-development`, `clinozy-production`). The frontend renders the site key; the backend
 * verifies with the secret — so they share one widget, with both origins in its domain list.
 */
function widgetName(config: SetupConfig, environmentName: string): string {
  return productResourceName(config, environmentName);
}

/**
 * Turnstile domains (hostnames) for an env: localhost for dev + the API host (app.frontendUrl, the
 * legacy name for the backend origin) + the frontend (clinozy-fe) origin (frontend.url), so the
 * shared widget renders on the frontend app's domain too.
 */
function domainsForEnvironment(config: SetupConfig, environmentName: string): string[] {
  const domains = new Set<string>();
  if (environmentName === 'development') domains.add('localhost');
  for (const url of [
    backendOriginForEnvironment(config, environmentName),
    frontendOriginForEnvironment(config, environmentName),
  ]) {
    if (!url) continue;
    try {
      domains.add(new URL(url).hostname);
    } catch {
      // ignore malformed URL
    }
  }
  if (domains.size === 0) domains.add('localhost');
  return [...domains];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function provisionTurnstile(context: InfraProviderContext): Promise<ProviderResult> {
  const { apiToken, accountId } = context.secrets.cloudflare;
  if (!(apiToken && accountId)) {
    return {
      success: true,
      message:
        'Turnstile: skipped (set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in .setup/.setup-credentials)',
    };
  }

  const widgetsPath = `/accounts/${accountId}/challenges/widgets`;
  let existing: TurnstileWidget[];
  try {
    existing = await cloudflareApi<TurnstileWidget[]>(apiToken, widgetsPath);
  } catch (error) {
    return { success: false, message: `Turnstile: cannot list widgets — ${errorMessage(error)}` };
  }

  for (const environmentName of context.environments) {
    const name = widgetName(context.config, environmentName);
    const found = existing.find((widget) => widget.name === name);
    const onFileSecret = readEnvFileValue(environmentName, 'CAPTCHA_SECRET');
    const desiredDomains = domainsForEnvironment(context.config, environmentName);

    try {
      // An existing widget keeps the domains it was created with; when the frontend or API host
      // changes (e.g. product.domain added), update them in place — site key and secret stay.
      if (found && !sameDomains(found.domains ?? [], desiredDomains)) {
        await cloudflareApi<TurnstileWidget>(apiToken, `${widgetsPath}/${found.sitekey}`, {
          method: 'PUT',
          body: JSON.stringify({ name, domains: desiredDomains, mode: found.mode ?? 'managed' }),
        });
        logger.success(
          `  Turnstile "${environmentName}" — domains updated: ${desiredDomains.join(', ')}`,
        );
      }
      if (found && onFileSecret) {
        // Already provisioned and we still hold its secret — keep it (don't rotate every run).
        upsertEnvFileValue(environmentName, 'CAPTCHA_PROVIDER', 'turnstile');
        upsertEnvFileValue(environmentName, 'CAPTCHA_SITE_KEY', found.sitekey);
        logger.success(`  Turnstile "${environmentName}" — widget "${name}" already provisioned`);
        continue;
      }

      let widget: TurnstileWidgetWithSecret;
      if (found) {
        // Remote widget exists but we don't hold the secret → rotate to obtain a usable one.
        const rotated = await cloudflareApi<TurnstileWidgetWithSecret>(
          apiToken,
          `${widgetsPath}/${found.sitekey}/rotate_secret`,
          { method: 'POST', body: '{}' },
        );
        widget = { name, sitekey: found.sitekey, secret: rotated.secret };
        logger.success(`  Turnstile "${environmentName}" — adopted "${name}" (secret rotated)`);
      } else {
        widget = await cloudflareApi<TurnstileWidgetWithSecret>(apiToken, widgetsPath, {
          method: 'POST',
          body: JSON.stringify({ name, domains: desiredDomains, mode: 'managed' }),
        });
        logger.success(`  Turnstile "${environmentName}" — created widget "${name}"`);
      }

      upsertEnvFileValue(environmentName, 'CAPTCHA_PROVIDER', 'turnstile');
      upsertEnvFileValue(environmentName, 'CAPTCHA_SITE_KEY', widget.sitekey);
      upsertEnvFileValue(environmentName, 'CAPTCHA_SECRET', widget.secret);
    } catch (error) {
      return { success: false, message: `Turnstile "${environmentName}": ${errorMessage(error)}` };
    }
  }

  return { success: true, message: 'Turnstile: widget(s) provisioned → .env.<environment>' };
}

export const setupCloudflareTurnstileProvider: InfraProvider = {
  key: 'turnstile',
  name: 'Cloudflare Turnstile',
  isEnabled: ({ config, secrets }) =>
    config.providers.turnstile.enabled &&
    isSecretFilled(secrets.cloudflare.apiToken) &&
    isSecretFilled(secrets.cloudflare.accountId),
  disabledReason: ({ config }) =>
    !config.providers.turnstile.enabled
      ? 'disabled in setup.config.json'
      : 'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID missing in .setup/.setup-credentials',
  preview: ({ config }) =>
    config.providers.turnstile.enabled
      ? {
          detail: 'Creates one Turnstile widget per env → writes CAPTCHA_* to .env.<environment>',
          url: TOKEN_URL,
          configKey: '.setup-credentials → CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID',
        }
      : null,
  settingsReview: ({ config }) =>
    config.providers.turnstile.enabled
      ? [{ bucket: 'resource', provider: 'Cloudflare Turnstile', detail: 'widget per environment' }]
      : [],
  describe: ({ environments }) => ({ environments }),
  inspectRemote: async (context) => {
    if (!context.config.providers.turnstile.enabled) {
      return { present: false, fields: [], error: 'disabled in setup.config.json' };
    }
    const { apiToken, accountId } = context.secrets.cloudflare;
    if (!(apiToken && accountId)) {
      return {
        present: false,
        fields: [],
        error: 'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID missing in .setup/.setup-credentials',
      };
    }
    try {
      const widgets = await cloudflareApi<TurnstileWidget[]>(
        apiToken,
        `/accounts/${accountId}/challenges/widgets`,
      );
      const fields = context.environments.map((environmentName) => {
        const name = widgetName(context.config, environmentName);
        const found = widgets.some((widget) => widget.name === name);
        return {
          label: `widget (${environmentName})`,
          expected: name,
          remote: found ? name : '—',
          matches: found,
        };
      });
      return { present: fields.every((field) => field.matches), fields };
    } catch (error) {
      return { present: false, fields: [], error: errorMessage(error) };
    }
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'Cloudflare Turnstile',
    enabled: setupCloudflareTurnstileProvider.isEnabled(context),
    enabledReason: setupCloudflareTurnstileProvider.disabledReason(context),
    instructions: [
      `Create a Cloudflare API token with Turnstile:Edit: ${TOKEN_URL}`,
      'Copy your Account ID (Cloudflare dashboard → any domain → Overview → right sidebar).',
      'Put both in .setup/.setup-credentials: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…',
      `Setup creates one widget per environment (${context.environments.join(', ')}) and writes`,
      'CAPTCHA_PROVIDER / CAPTCHA_SITE_KEY / CAPTCHA_SECRET into each .env.<environment>.',
      'Idempotent: an existing widget is adopted; a secret already on file is kept.',
    ],
    detectStatus: () =>
      resourceStatus(
        everyEnvironmentHasEnvKeys(context.config, ['CAPTCHA_SITE_KEY', 'CAPTCHA_SECRET']),
        'Turnstile widget per environment',
      ),
    execute: () => provisionTurnstile(context),
  }),
};
