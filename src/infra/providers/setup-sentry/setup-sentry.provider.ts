/**
 * Sentry provider for `pnpm setup:infra`.
 *
 * Creates or adopts the Sentry project and records the DSN to state so build-env-vars
 * wires SENTRY_DSN per environment.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only (via build-env-vars), never printed to the
 * console; setup secret files are gitignored and unreadable by the agent (deny-read guard). See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import * as logger from '@setup/common/logger.js';
import { isSecretFilled } from '@setup/common/secrets.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import type {
  SetupConfig,
  SetupSecrets,
  SetupState,
  ProviderResult,
  InfraProvider,
  InfraProviderContext,
} from '@setup/common/types.js';

const SENTRY_API_BASE = 'https://sentry.io/api/0';

function sentryHeaders(authToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function sentryRequest<T>(
  authToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await setupFetch({
    name: 'Sentry',
    url: `${SENTRY_API_BASE}${path}`,
    init: {
      method,
      headers: sentryHeaders(authToken),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Sentry API ${method} ${path} failed (${response.status}): ${errorBody}`);
  }

  return response.json() as Promise<T>;
}

interface SentryProject {
  id: string;
  slug: string;
  name: string;
}

interface SentryKey {
  dsn: {
    public: string;
  };
}

type SentryConfig = SetupConfig['providers']['sentry'];

/** Adopt (by name) or create one Sentry project and resolve its public DSN. */
async function resolveProjectAndDsn(
  authToken: string,
  sentryConfig: SentryConfig,
  projectName: string,
  platform: string,
  knownSlug?: string,
  knownDsn?: string,
): Promise<{ projectSlug: string; dsn: string }> {
  let projectSlug = knownSlug;
  let dsn = knownDsn;

  if (!projectSlug) {
    try {
      const existing = await sentryRequest<SentryProject>(
        authToken,
        'GET',
        `/projects/${sentryConfig.organization}/${projectName}/`,
      );
      projectSlug = existing.slug;
    } catch {
      const created = await sentryRequest<SentryProject>(
        authToken,
        'POST',
        `/teams/${sentryConfig.organization}/${sentryConfig.team ?? sentryConfig.project}/projects/`,
        { name: projectName, slug: projectName, platform },
      );
      projectSlug = created.slug;
    }
  }

  if (!dsn) {
    const keys = await sentryRequest<SentryKey[]>(
      authToken,
      'GET',
      `/projects/${sentryConfig.organization}/${projectSlug}/keys/`,
    );
    const firstKey = keys[0];
    if (!firstKey) throw new Error(`No client keys found for Sentry project "${projectSlug}"`);
    dsn = firstKey.dsn.public;
  }

  return { projectSlug, dsn };
}

export async function provision(
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
): Promise<ProviderResult> {
  const authToken = secrets.sentry.authToken;
  const sentryConfig = config.providers.sentry;

  const spinner = logger.startSpinner('Setting up Sentry project(s)...');

  try {
    // Backend project (config.project.name) — the existing SENTRY_DSN.
    const backend = await resolveProjectAndDsn(
      authToken,
      sentryConfig,
      config.project.name,
      sentryConfig.platform,
      state.sentry?.projectSlug,
      state.sentry?.dsn,
    );

    // Frontend (clinozy-fe) project — a SEPARATE project so the browser gets its own DSN.
    let frontend: { projectSlug: string; dsn: string } | undefined;
    if (config.frontend?.name) {
      frontend = await resolveProjectAndDsn(
        authToken,
        sentryConfig,
        config.frontend.name,
        'javascript',
        state.sentry?.frontendProjectSlug,
        state.sentry?.frontendDsn,
      );
    }

    logger.stopSpinner(
      spinner,
      frontend
        ? `Sentry projects ready: ${backend.projectSlug} + ${frontend.projectSlug}`
        : `Sentry project ready: ${backend.projectSlug}`,
    );

    return {
      success: true,
      message: `Sentry: project "${backend.projectSlug}" ready`,
      stateUpdates: {
        sentry: {
          projectSlug: backend.projectSlug,
          dsn: backend.dsn,
          ...(frontend
            ? { frontendProjectSlug: frontend.projectSlug, frontendDsn: frontend.dsn }
            : {}),
        },
      },
    };
  } catch (provisionError) {
    const message =
      provisionError instanceof Error ? provisionError.message : String(provisionError);
    logger.stopSpinner(spinner, `Sentry provisioning failed: ${message}`, 'fail');
    return { success: false, message };
  }
}

export async function check(
  state: SetupState,
  secrets: SetupSecrets,
  organization: string,
): Promise<boolean> {
  if (!state.sentry?.projectSlug) {
    logger.error('Sentry: no project in state');
    return false;
  }

  try {
    await sentryRequest(
      secrets.sentry.authToken,
      'GET',
      `/projects/${organization}/${state.sentry.projectSlug}/`,
    );
    logger.success(`Sentry project "${state.sentry.projectSlug}" — reachable`);
    return true;
  } catch {
    logger.error(`Sentry project "${state.sentry.projectSlug}" — unreachable`);
    return false;
  }
}

export const setupSentryProvider: InfraProvider = {
  key: 'sentry',
  name: 'Sentry',
  isEnabled: ({ config, secrets }) =>
    config.providers.sentry.enabled && isSecretFilled(secrets.sentry.authToken),
  disabledReason: ({ config }) =>
    !config.providers.sentry.enabled
      ? 'disabled in setup.config.json'
      : 'SENTRY_AUTH_TOKEN missing in .setup/.setup-credentials',
  preview: ({ config }) =>
    config.providers.sentry.enabled
      ? {
          detail: 'Auth token',
          url: 'https://sentry.io/settings/auth-tokens/new-token/',
          configKey: 'sentry.authToken',
        }
      : null,
  settingsReview: ({ config }) =>
    config.providers.sentry.enabled
      ? [
          {
            bucket: 'resource',
            provider: 'Sentry',
            detail: `${config.frontend?.name ? 2 : 1} project${config.frontend?.name ? 's' : ''} (${config.providers.sentry.organization}/${
              config.providers.sentry.project ?? config.providers.sentry.team
            }${config.frontend?.name ? ` + ${config.frontend.name}` : ''})`,
          },
        ]
      : [],
  detectExisting: async ({ config, secrets }) => {
    if (!(config.providers.sentry.enabled && isSecretFilled(secrets.sentry.authToken))) return [];
    try {
      const response = await setupFetch({
        name: 'Sentry',
        url: `https://sentry.io/api/0/projects/${config.providers.sentry.organization}/${config.project.name}/`,
        init: {
          headers: {
            Authorization: `Bearer ${secrets.sentry.authToken}`,
            Accept: 'application/json',
          },
        },
      });
      if (response.ok) {
        return [
          {
            provider: 'Sentry',
            detail: `project "${config.project.name}" already exists`,
          },
        ];
      }
    } catch {
      logger.warn('  Could not check Sentry for existing resources');
    }
    return [];
  },
  describe: ({ config, environments }) => ({
    organization: config.providers.sentry.organization,
    project: config.providers.sentry.project ?? config.project.name,
    environments,
  }),
  inspectRemote: async ({ config, secrets }) => {
    const sentry = config.providers.sentry;
    if (!sentry.enabled)
      return { present: false, fields: [], error: 'disabled in setup.config.json' };
    if (!isSecretFilled(secrets.sentry.authToken)) {
      return {
        present: false,
        fields: [],
        error: 'SENTRY_AUTH_TOKEN missing in .setup/.setup-credentials',
      };
    }
    const organization = sentry.organization;
    const project = sentry.project ?? config.project.name;
    try {
      const response = await setupFetch({
        name: 'Sentry',
        url: `${SENTRY_API_BASE}/projects/${organization}/${project}/`,
        init: {
          headers: {
            Authorization: `Bearer ${secrets.sentry.authToken}`,
            Accept: 'application/json',
          },
        },
      });
      if (response.status === 404) {
        return {
          present: false,
          fields: [
            {
              label: 'organization',
              expected: organization,
              remote: organization,
              matches: true,
              prerequisite: true,
            },
            { label: 'project', expected: project, remote: '—', matches: false },
          ],
        };
      }
      if (!response.ok)
        return { present: false, fields: [], error: `Sentry API returned ${response.status}` };
      const body = (await response.json()) as { slug?: string; platform?: string };
      return {
        present: true,
        fields: [
          {
            label: 'organization',
            expected: organization,
            remote: organization,
            matches: true,
            prerequisite: true,
          },
          {
            label: 'project',
            expected: project,
            remote: body.slug ?? '—',
            matches: body.slug === project,
          },
          {
            label: 'platform',
            expected: sentry.platform,
            remote: body.platform ?? '—',
            matches: body.platform === sentry.platform,
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
  toEnvironmentVariables: ({ config, state }, environmentName) => {
    const sentryConfig = config.providers.sentry;
    if (!(sentryConfig.enabled && state.sentry?.dsn)) return {};
    const rates = sentryConfig.sampleRates[environmentName];
    return {
      SENTRY_DSN: state.sentry.dsn,
      SENTRY_ENVIRONMENT: environmentName,
      ...(state.sentry.frontendDsn ? { SENTRY_FRONTEND_DSN: state.sentry.frontendDsn } : {}),
      ...(rates
        ? {
            SENTRY_TRACES_SAMPLE_RATE: String(rates.traces),
            SENTRY_PROFILE_SAMPLE_RATE: String(rates.profile),
          }
        : {}),
    };
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'Sentry',
    enabled: setupSentryProvider.isEnabled(context),
    enabledReason: setupSentryProvider.disabledReason(context),
    instructions: [
      `Will create or adopt the backend Sentry project: ${context.config.providers.sentry.organization}/${
        context.config.providers.sentry.project ?? context.config.providers.sentry.team
      }.`,
      ...(context.config.frontend?.name
        ? [
            `Plus a SEPARATE frontend project "${context.config.frontend.name}" → SENTRY_FRONTEND_DSN`,
            '  (browser-safe; retrieve it for clinozy-fe via `pnpm setup:infra:frontend`).',
          ]
        : []),
      'Exports the same DSN into each `.env.<environment>` with matching `SENTRY_ENVIRONMENT` (development, production) — one Sentry project, not one per env.',
    ],
    detectStatus: () => resourceStatus(Boolean(context.state.sentry?.dsn), 'Sentry DSN in state'),
    execute: async () => {
      const result = await provision(context.config, context.secrets, context.state);
      if (!result.success) throw new Error(result.message);
      context.applyStateUpdates(result.stateUpdates ?? {});
      return result;
    },
    verifyState: () => ({
      ok: Boolean(context.state.sentry?.dsn),
      message: context.state.sentry?.projectSlug
        ? `project "${context.state.sentry.projectSlug}" with DSN`
        : 'no Sentry DSN recorded',
    }),
    verifyLive: async () => {
      const ok = await check(
        context.state,
        context.secrets,
        context.config.providers.sentry.organization,
      );
      return { ok, message: ok ? 'reachable' : 'unreachable' };
    },
  }),
  check: ({ config, state, secrets }) =>
    check(state, secrets, config.providers.sentry.organization),
  deleteInstructions: ({ config, state }) => {
    if (!state.sentry?.projectSlug) return [];
    const organization = config.providers.sentry.organization;
    return [
      {
        provider: 'Sentry',
        dashboardUrl: `https://sentry.io/settings/${organization}/projects/${state.sentry.projectSlug}/`,
        steps: [
          'Open the project page above.',
          'Settings → Remove Project (or, for the team, Settings → Teams → Remove team).',
        ],
        resources: [
          { label: 'Project slug', identifier: state.sentry.projectSlug },
          ...(state.sentry.dsn
            ? [{ label: 'DSN (will be invalidated)', identifier: state.sentry.dsn }]
            : []),
          ...(state.sentry.frontendProjectSlug
            ? [{ label: 'Frontend project slug', identifier: state.sentry.frontendProjectSlug }]
            : []),
        ],
      },
    ];
  },
};
