/**
 * Netlify provider for `pnpm setup:infra`.
 *
 * Finds the frontend's Netlify site from its production URL — adopts it when it exists, creates it
 * when it does not — and records it so the frontend env export writes NETLIFY_SITE_ID (and
 * NETLIFY_AUTH_TOKEN) into the frontend repo. One site serves every environment: production
 * deploys with `--prod`, the others as aliases (`<env>--<site>.netlify.app`), so the id is the same
 * in every `.env.<environment>`.
 *
 * NAMING (single source of truth = setup.config.json): a `*.netlify.app` production URL
 * (`frontend.url.<production env>`) names the site by its first label; a custom domain uses
 * `frontend.name` and is attached to the site on creation — never hardcoded.
 * SECRETS: NETLIFY_AUTH_TOKEN comes from `.setup-credentials` or the Netlify CLI's saved login, is
 * never printed, and is written only to the frontend env (see frontend-env-keys.ts).
 */
import * as logger from '@setup/common/logger.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import { SetupError } from '@setup/common/setup-error.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import { frontendOriginForEnvironment } from '@setup/envs/env-file-setup.util.js';
import type {
  InfraProvider,
  InfraProviderContext,
  ProviderResult,
  SetupConfig,
  SetupState,
} from '@setup/common/types.js';

const NETLIFY_API = 'https://api.netlify.com/api/v1';
const NETLIFY_SUBDOMAIN_SUFFIX = '.netlify.app';
const NETLIFY_TOKEN_URL = 'https://app.netlify.com/user/applications#personal-access-tokens';

type FetchImplementation = (url: string, init?: RequestInit) => Promise<Response>;

/** Which site the frontend deploys to, derived from config. */
export interface NetlifySiteTarget {
  /** Netlify site name — the `<name>` in `<name>.netlify.app`. */
  readonly siteName: string;
  /** Custom production domain, when the production URL is not a `*.netlify.app` host. */
  readonly customDomain?: string;
}

interface NetlifySite {
  id: string;
  name: string;
  ssl_url?: string;
  url?: string;
  custom_domain?: string | null;
}

type NetlifyState = NonNullable<SetupState['netlify']>;

/** The environment that deploys with `--prod` (its `nodeEnvironment` is production). */
function productionEnvironmentName(config: SetupConfig): string | undefined {
  return config.environments.find((environment) => environment.nodeEnvironment === 'production')
    ?.name;
}

/** The site to find or create, or `undefined` when there is no production frontend URL. */
export function netlifySiteTarget(config: SetupConfig): NetlifySiteTarget | undefined {
  const environmentName = productionEnvironmentName(config);
  const origin = environmentName ? frontendOriginForEnvironment(config, environmentName) : '';
  if (!origin) return undefined;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return undefined;
  }
  if (host.endsWith(NETLIFY_SUBDOMAIN_SUFFIX)) {
    const siteName = host.slice(0, -NETLIFY_SUBDOMAIN_SUFFIX.length);
    // `<alias>--<site>.netlify.app` is a deploy alias, not a site name.
    return siteName && !siteName.includes('.') && !siteName.includes('--')
      ? { siteName }
      : undefined;
  }
  const name = config.frontend?.name;
  return name ? { siteName: name, customDomain: host } : undefined;
}

const authHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

const withFetch = (fetchImplementation?: FetchImplementation) =>
  fetchImplementation ? { fetchImplementation } : {};

/** Look the site up by domain (Netlify accepts a site's domain in place of its id). */
export async function findNetlifySite(
  token: string,
  target: NetlifySiteTarget,
  fetchImplementation?: FetchImplementation,
): Promise<NetlifySite | undefined> {
  const domains = [target.customDomain, `${target.siteName}${NETLIFY_SUBDOMAIN_SUFFIX}`].filter(
    (domain): domain is string => Boolean(domain),
  );
  for (const domain of domains) {
    const response = await setupFetch({
      name: 'Netlify',
      url: `${NETLIFY_API}/sites/${encodeURIComponent(domain)}`,
      init: { headers: authHeaders(token) },
      expectedStatus: [200, 404],
      ...withFetch(fetchImplementation),
    });
    if (response.status === 200) return (await response.json()) as NetlifySite;
  }
  return undefined;
}

/** Adopt the site when it exists; create it otherwise. */
export async function ensureNetlifySite(
  token: string,
  target: NetlifySiteTarget,
  fetchImplementation?: FetchImplementation,
): Promise<{ site: NetlifySite; created: boolean }> {
  const existing = await findNetlifySite(token, target, fetchImplementation);
  if (existing) {
    // An adopted site may predate the custom domain (e.g. product.domain added later) — attach it.
    // Netlify accepts it before DNS exists and serves it once the CNAME points at the site.
    if (target.customDomain && existing.custom_domain !== target.customDomain) {
      const response = await setupFetch({
        name: 'Netlify',
        url: `${NETLIFY_API}/sites/${encodeURIComponent(existing.id)}`,
        init: {
          method: 'PATCH',
          headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ custom_domain: target.customDomain }),
        },
        expectedStatus: 200,
        ...withFetch(fetchImplementation),
      });
      return { site: (await response.json()) as NetlifySite, created: false };
    }
    return { site: existing, created: false };
  }

  const response = await setupFetch({
    name: 'Netlify',
    url: `${NETLIFY_API}/sites`,
    init: {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: target.siteName,
        ...(target.customDomain ? { custom_domain: target.customDomain } : {}),
      }),
    },
    expectedStatus: [200, 201, 422],
    ...withFetch(fetchImplementation),
  });
  if (response.status === 422) {
    throw new SetupError(`Netlify rejected the new site "${target.siteName}".`, {
      hint: `Site names are global — "${target.siteName}" is likely taken by another account. Change the production frontend URL (or frontend.name for a custom domain) in setup.config.json and re-run.`,
    });
  }
  return { site: (await response.json()) as NetlifySite, created: true };
}

function toState(site: NetlifySite, target: NetlifySiteTarget): NetlifyState {
  return {
    siteId: site.id,
    siteName: site.name,
    url: site.ssl_url ?? site.url ?? `https://${target.siteName}${NETLIFY_SUBDOMAIN_SUFFIX}`,
  };
}

export async function provision(
  config: SetupConfig,
  token: string,
  fetchImplementation?: FetchImplementation,
): Promise<ProviderResult> {
  const target = netlifySiteTarget(config);
  if (!target) {
    return { success: false, message: 'Netlify: no production frontend URL to name the site' };
  }
  const { site, created } = await ensureNetlifySite(token, target, fetchImplementation);
  logger.success(
    `  Netlify site "${site.name}" — ${created ? 'created' : 'adopted'} (serves every environment)`,
  );
  if (target.customDomain) {
    logger.info(
      `    Custom domain ${target.customDomain} — DNS: CNAME ${target.customDomain} → ${site.name}.netlify.app`,
    );
  }
  return {
    success: true,
    message: `Netlify: site ${site.name} ${created ? 'created' : 'adopted'}`,
    stateUpdates: { netlify: toState(site, target) },
  };
}

function isConfigEnabled(config: SetupConfig): boolean {
  return config.providers.netlify?.enabled === true;
}

export const setupNetlifyProvider: InfraProvider = {
  key: 'netlify',
  name: 'Netlify',
  isEnabled: ({ config, secrets }) =>
    isConfigEnabled(config) &&
    Boolean(netlifySiteTarget(config)) &&
    Boolean(secrets.netlify?.authToken),
  disabledReason: ({ config, secrets }) => {
    if (!isConfigEnabled(config)) return 'disabled in setup.config.json';
    if (!netlifySiteTarget(config)) {
      return 'no production frontend URL (frontend.url.<production env>) to name the site after';
    }
    return secrets.netlify?.authToken
      ? ''
      : 'NETLIFY_AUTH_TOKEN missing in .setup/.setup-credentials (or log in with the Netlify CLI)';
  },
  preview: ({ config }) =>
    isConfigEnabled(config)
      ? { detail: 'Personal access token', url: NETLIFY_TOKEN_URL, configKey: 'netlify.authToken' }
      : null,
  settingsReview: ({ config }) => {
    const target = netlifySiteTarget(config);
    return isConfigEnabled(config) && target
      ? [
          {
            bucket: 'resource',
            provider: 'Netlify',
            detail: `site ${target.siteName}${target.customDomain ? ` (${target.customDomain})` : ''} — frontend, all environments`,
          },
        ]
      : [];
  },
  describe: ({ config }) => {
    const siteName = netlifySiteTarget(config)?.siteName;
    return siteName ? { project: siteName } : {};
  },
  detectRemote: async ({ config, secrets }) => {
    const target = netlifySiteTarget(config);
    const token = secrets.netlify?.authToken;
    if (!(isConfigEnabled(config) && target && token)) return {};
    const site = await findNetlifySite(token, target);
    return site ? { netlify: toState(site, target) } : {};
  },
  inspectRemote: async ({ config, secrets }) => {
    const target = netlifySiteTarget(config);
    const token = secrets.netlify?.authToken;
    if (!(target && token)) {
      return { present: false, fields: [], error: 'no token or production frontend URL' };
    }
    try {
      const site = await findNetlifySite(token, target);
      return {
        present: Boolean(site),
        fields: [
          {
            label: 'site',
            expected: target.siteName,
            remote: site?.name ?? '—',
            matches: site?.name === target.siteName,
          },
        ],
      };
    } catch (error) {
      return {
        present: false,
        fields: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'Netlify',
    enabled: true,
    instructions: [
      `Will find (or create) the frontend's Netlify site "${netlifySiteTarget(context.config)?.siteName ?? '—'}".`,
      'One site serves every environment; its id is written to the frontend env as NETLIFY_SITE_ID.',
    ],
    detectStatus: () =>
      resourceStatus(
        Boolean(context.state.netlify?.siteId),
        `site ${context.state.netlify?.siteName ?? ''} recorded`,
      ),
    execute: async () => {
      const token = context.secrets.netlify?.authToken ?? '';
      const result = await provision(context.config, token);
      context.applyStateUpdates(result.stateUpdates ?? {});
      return result;
    },
    verifyState: () => ({
      ok: Boolean(context.state.netlify?.siteId),
      message: context.state.netlify
        ? `site ${context.state.netlify.siteName} (${context.state.netlify.url})`
        : 'no Netlify site recorded',
    }),
  }),
  check: async ({ state, secrets }) => {
    const siteId = state.netlify?.siteId;
    const token = secrets.netlify?.authToken;
    if (!(siteId && token)) return true;
    const response = await setupFetch({
      name: 'Netlify',
      url: `${NETLIFY_API}/sites/${encodeURIComponent(siteId)}`,
      init: { headers: authHeaders(token) },
      expectedStatus: [200, 404],
    });
    return response.status === 200;
  },
  deleteInstructions: ({ state }) => {
    const site = state.netlify;
    if (!site) return [];
    return [
      {
        provider: 'Netlify',
        dashboardUrl: `https://app.netlify.com/sites/${site.siteName}/configuration/general`,
        steps: ['Site configuration → General → Danger zone → Delete this site.'],
        resources: [{ label: 'Site (all environments)', identifier: site.siteName }],
      },
    ];
  },
};
