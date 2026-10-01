/**
 * PostHog provider for `pnpm setup:infra`.
 *
 * Reads POSTHOG_PERSONAL_API_KEY from `.setup/.setup-credentials` (NOT a runtime .env file),
 * resolves the public project API key (`phc_…`) via the PostHog API, and writes
 * POSTHOG_KEY + POSTHOG_HOST into each `.env.<environment>`.
 *
 * NAMING (single source of truth = setup.config.json):
 *   • project name        = config.project.name          (reuse if it exists)
 *   • organization name   = config.project.organization  (created if the key has none)
 *   • environment names   = config.environments[].name
 * SECRETS: the personal key lives only in `.setup/.setup-credentials` (gitignored, never
 * printed). The resolved project key is public and written to `.env.<environment>`.
 * See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import * as logger from '@setup/common/logger.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import { getEnvSetupValue } from '@setup/common/secrets.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import { readEnvFileValue } from '@setup/envs/read-env-file.js';
import {
  assertCredentialCollectionNotAborted,
  formatEnvCredentialCollectionSummary,
  productName,
  productResourceName,
  resolveDefaultEnvironmentName,
  type CollectEnvCredentialsResult,
} from '@setup/envs/env-file-setup.util.js';
import { collectEnvCredentialsForContext } from '@setup/envs/collect-env-credentials-for-context.js';
import type {
  SetupConfig,
  SetupState,
  ProviderResult,
  InfraProvider,
  InfraProviderContext,
} from '@setup/common/types.js';

interface PosthogSetupCredentials {
  personalApiKey: string;
  projectApiKey?: string;
  projectId?: string;
}

interface PosthogHosts {
  apiHost: string;
  ingestHost: string;
}

interface PosthogProject {
  id?: number;
  name?: string;
  api_token?: string;
}

const POSTHOG_PROJECT_WRITE_GUIDANCE =
  'PostHog returned 403 — project create needs an Admin/Owner role and a personal API key with the project:write scope (or paste phc_… keys manually). ' +
  'Regenerate the key at https://us.posthog.com/settings/user-api-keys with "All access", or set POSTHOG_PROJECT_API_KEY=phc_… in .setup/.setup-credentials.';

function expectedProjectNamesForEnvironment(
  config: SetupConfig,
  environmentName: string,
): string[] {
  const primary = productResourceName(config, environmentName);
  const legacy = `${config.project.name}-${environmentName}`;
  return legacy === primary ? [primary] : [primary, legacy];
}

function indexProjectsByName(projects: PosthogProject[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const project of projects) {
    if (!(project.name && project.api_token)) continue;
    index.set(project.name, project.api_token);
    index.set(project.name.toLowerCase(), project.api_token);
  }
  return index;
}

function findProjectToken(index: Map<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const token = index.get(name) ?? index.get(name.toLowerCase());
    if (token) return token;
  }
  return undefined;
}

async function readPosthogErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return '';
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return '';
  }
}

/**
 * Read a usable per-env PostHog project key from `.env.<environment>` (or a global setup override):
 * the `POSTHOG_PROJECT_API_KEY` input if present, else the previously-resolved `POSTHOG_KEY` output.
 *
 * @remarks
 * Recognizing `POSTHOG_KEY` makes re-runs idempotent: once a project is resolved (or reused because
 * the plan is at its project limit), the key is written to `.env.<environment>` as `POSTHOG_KEY`, so
 * later runs adopt it directly here — no API call, no repeated create attempt, no repeated
 * "cannot create … reusing" warning.
 */
function readPerEnvProjectApiKeys(config: SetupConfig): Record<string, string> | null {
  const globalKey = getEnvSetupValue('POSTHOG_PROJECT_API_KEY');
  const keys: Record<string, string> = {};
  for (const environment of config.environments) {
    const key =
      readEnvFileValue(environment.name, 'POSTHOG_PROJECT_API_KEY') ??
      readEnvFileValue(environment.name, 'POSTHOG_KEY') ??
      globalKey;
    if (!key) return null;
    keys[environment.name] = key;
  }
  return keys;
}

function isPosthogPermissionError(message: string): boolean {
  return /returned 403|project:write|Admin or Owner/i.test(message);
}

function resolveHosts(region: 'us' | 'eu'): PosthogHosts {
  return region === 'eu'
    ? { apiHost: 'https://eu.posthog.com', ingestHost: 'https://eu.i.posthog.com' }
    : { apiHost: 'https://us.posthog.com', ingestHost: 'https://us.i.posthog.com' };
}

/** Read the PostHog setup inputs from `.setup/.setup-credentials`. */
function readPosthogCredentials(): PosthogSetupCredentials {
  const credentials: PosthogSetupCredentials = {
    personalApiKey: getEnvSetupValue('POSTHOG_PERSONAL_API_KEY'),
  };
  const projectApiKey = getEnvSetupValue('POSTHOG_PROJECT_API_KEY');
  const projectId = getEnvSetupValue('POSTHOG_PROJECT_ID');
  if (projectApiKey) credentials.projectApiKey = projectApiKey;
  if (projectId) credentials.projectId = projectId;
  return credentials;
}

/**
 * Resolve the public project API key (`phc_…`):
 *   1. verbatim `projectApiKey` override → used as-is (no API call)
 *   2. `projectId` override → GET /api/projects/<id>/ → api_token
 *   3. reuse the project named `config.project.name` if it already exists
 *   4. otherwise create an organization named `config.project.organization`
 *      (PostHog gives it one free project) and name that project after the repo
 */
/** Resolve the PostHog organization id — prefer a name match, then @current, then create. */
async function resolveOrganizationId(
  apiHost: string,
  headers: Record<string, string>,
  organizationName: string,
): Promise<{ orgId: string; bootstrapProject?: PosthogProject } | { error: string }> {
  const listResponse = await setupFetch({
    name: 'PostHog',
    url: `${apiHost}/api/organizations/`,
    init: { headers },
  });
  if (listResponse.ok) {
    const listBody = (await listResponse.json()) as {
      results?: Array<{ id?: string | number; name?: string }>;
    };
    const match = listBody.results?.find(
      (organization) => organization.name?.toLowerCase() === organizationName.toLowerCase(),
    );
    if (match?.id != null) return { orgId: String(match.id) };
  }

  const current = await setupFetch({
    name: 'PostHog',
    url: `${apiHost}/api/organizations/@current/`,
    init: { headers },
  });
  if (current.ok) {
    const body = (await current.json()) as { id?: string | number; name?: string };
    if (body.id != null) {
      if (body.name && body.name.toLowerCase() !== organizationName.toLowerCase()) {
        logger.warn(
          `PostHog: no org named "${organizationName}" — using current org "${body.name}" (${body.id}).`,
        );
      }
      return { orgId: String(body.id) };
    }
  }

  const created = await setupFetch({
    name: 'PostHog',
    url: `${apiHost}/api/organizations/`,
    init: { method: 'POST', headers, body: JSON.stringify({ name: organizationName }) },
  });
  if (!created.ok) {
    const detail = await readPosthogErrorBody(created);
    const suffix = created.status === 403 ? ` ${POSTHOG_PROJECT_WRITE_GUIDANCE}` : '';
    return {
      error: `PostHog organization create returned ${created.status}${detail ? `: ${detail}` : ''}${suffix}`,
    };
  }
  const body = (await created.json()) as { id?: string | number; teams?: PosthogProject[] };
  if (body.id == null) return { error: 'PostHog organization created but returned no id' };
  const bootstrapProject = body.teams?.[0];
  return { orgId: String(body.id), ...(bootstrapProject ? { bootstrapProject } : {}) };
}

async function listOrganizationProjects(
  apiHost: string,
  headers: Record<string, string>,
  orgId: string,
): Promise<PosthogProject[]> {
  const response = await setupFetch({
    name: 'PostHog',
    url: `${apiHost}/api/organizations/${orgId}/projects/`,
    init: { headers },
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { results?: PosthogProject[] };
  return body.results ?? [];
}

/** Create a project named `name` in `orgId`; returns its public api_token. */
async function createProject(
  apiHost: string,
  headers: Record<string, string>,
  orgId: string,
  name: string,
): Promise<{ apiKey: string } | { error: string }> {
  const response = await setupFetch({
    name: 'PostHog',
    url: `${apiHost}/api/organizations/${orgId}/projects/`,
    init: { method: 'POST', headers, body: JSON.stringify({ name }) },
  });
  if (!response.ok) {
    const detail = await readPosthogErrorBody(response);
    const suffix = response.status === 403 ? ` ${POSTHOG_PROJECT_WRITE_GUIDANCE}` : '';
    return {
      error: `PostHog project create (${name}) returned ${response.status}${detail ? `: ${detail}` : ''}${suffix}`,
    };
  }
  const body = (await response.json()) as PosthogProject;
  if (!body.api_token) return { error: `PostHog project "${name}" returned no api_token` };
  return { apiKey: body.api_token };
}

/** Best-effort rename so a freshly bootstrapped "Default project" matches our `clinozy-<env>` scheme. */
async function renameProject(
  apiHost: string,
  headers: Record<string, string>,
  projectId: number,
  name: string,
): Promise<void> {
  try {
    await setupFetch({
      name: 'PostHog',
      url: `${apiHost}/api/projects/${projectId}/`,
      init: { method: 'PATCH', headers, body: JSON.stringify({ name }) },
    });
  } catch {
    logger.warn(`PostHog: created project but could not rename it to "${name}".`);
  }
}

/**
 * Resolve ONE shared PostHog project per environment (`<product>-<env>`), creating any missing
 * ones inside a single organization. Explicit `projectApiKey`/`projectId` overrides apply to every
 * environment (same key everywhere).
 */
async function resolvePerEnvProjectKeys(
  credentials: PosthogSetupCredentials,
  apiHost: string,
  config: SetupConfig,
): Promise<{ projectApiKeys: Record<string, string> } | { error: string }> {
  const environmentNames = config.environments.map((environment) => environment.name);
  const sameKeyEverywhere = (key: string): { projectApiKeys: Record<string, string> } => ({
    projectApiKeys: Object.fromEntries(environmentNames.map((name) => [name, key])),
  });

  if (credentials.projectApiKey) return sameKeyEverywhere(credentials.projectApiKey);

  const fromEnvFiles = readPerEnvProjectApiKeys(config);
  if (fromEnvFiles) return { projectApiKeys: fromEnvFiles };

  const { personalApiKey } = credentials;
  if (!personalApiKey) {
    return {
      error:
        'POSTHOG_PERSONAL_API_KEY missing in .setup/.setup-credentials — cannot resolve POSTHOG_KEY',
    };
  }
  const headers = { Authorization: `Bearer ${personalApiKey}`, 'Content-Type': 'application/json' };

  try {
    if (credentials.projectId) {
      const response = await setupFetch({
        name: 'PostHog',
        url: `${apiHost}/api/projects/${credentials.projectId}/`,
        init: { headers },
      });
      if (!response.ok) return { error: `PostHog API returned ${response.status}` };
      const body = (await response.json()) as PosthogProject;
      if (!body.api_token)
        return { error: `Project ${credentials.projectId} returned no api_token` };
      return sameKeyEverywhere(body.api_token);
    }

    // List projects once and match each env's `<product>-<env>` project by name.
    const listResponse = await setupFetch({
      name: 'PostHog',
      url: `${apiHost}/api/projects/`,
      init: { headers },
    });
    if (!listResponse.ok) return { error: `PostHog API returned ${listResponse.status}` };
    const listBody = (await listResponse.json()) as { results?: PosthogProject[] };
    const globalIndex = indexProjectsByName(listBody.results ?? []);

    const projectApiKeys: Record<string, string> = {};
    const missing: string[] = [];
    for (const environmentName of environmentNames) {
      const names = expectedProjectNamesForEnvironment(config, environmentName);
      const existing = findProjectToken(globalIndex, names);
      if (existing) projectApiKeys[environmentName] = existing;
      else missing.push(environmentName);
    }
    if (missing.length === 0) return { projectApiKeys };

    // Ensure ONE org, then adopt or create the missing per-env projects inside it.
    const org = await resolveOrganizationId(apiHost, headers, config.project.organization);
    if ('error' in org) return org;

    const orgIndex = indexProjectsByName(
      await listOrganizationProjects(apiHost, headers, org.orgId),
    );
    for (const environmentName of [...missing]) {
      const names = expectedProjectNamesForEnvironment(config, environmentName);
      const adopted = findProjectToken(orgIndex, names);
      if (adopted) {
        projectApiKeys[environmentName] = adopted;
        const missingIndex = missing.indexOf(environmentName);
        if (missingIndex >= 0) missing.splice(missingIndex, 1);
      }
    }
    if (missing.length === 0) return { projectApiKeys };

    // Existing project tokens (global + org) — the fallback when creation is blocked by a plan
    // project limit or missing project:write, so a free-tier account can still finish setup.
    const existingTokens = [...globalIndex.values(), ...orgIndex.values()].filter(Boolean);

    let bootstrap = org.bootstrapProject;
    for (const environmentName of missing) {
      const name = productResourceName(config, environmentName);
      if (bootstrap?.api_token) {
        if (bootstrap.id != null) await renameProject(apiHost, headers, bootstrap.id, name);
        projectApiKeys[environmentName] = bootstrap.api_token;
        bootstrap = undefined;
        continue;
      }
      const created = await createProject(apiHost, headers, org.orgId, name);
      if ('error' in created) {
        // Plan project limit / no create permission (403): reuse an existing project instead of
        // failing to a manual phc_ paste. Lets free-tier accounts at their cap proceed.
        const reuseToken = existingTokens[0];
        if (isPosthogPermissionError(created.error) && reuseToken) {
          logger.warn(
            `PostHog: cannot create "${name}" (plan project limit or no project:write) — reusing an existing project for "${environmentName}".`,
          );
          projectApiKeys[environmentName] = reuseToken;
          continue;
        }
        return created;
      }
      projectApiKeys[environmentName] = created.apiKey;
    }
    return { projectApiKeys };
  } catch (resolutionError) {
    return {
      error: resolutionError instanceof Error ? resolutionError.message : String(resolutionError),
    };
  }
}

export async function provision(config: SetupConfig): Promise<ProviderResult> {
  if (!config.providers.posthog.enabled) {
    return { success: true, message: 'PostHog: skipped (disabled)' };
  }

  const credentials = readPosthogCredentials();
  const { apiHost, ingestHost } = resolveHosts(config.providers.posthog.region);
  const spinner = logger.startSpinner('Resolving PostHog project keys...');
  const resolved = await resolvePerEnvProjectKeys(credentials, apiHost, config);

  if ('error' in resolved) {
    logger.failActiveSpinner(`PostHog: ${resolved.error}`);
    return { success: false, message: resolved.error };
  }

  logger.stopSpinner(
    spinner,
    `PostHog project(s) resolved: ${Object.keys(resolved.projectApiKeys).join(', ')} (${ingestHost})`,
  );
  return {
    success: true,
    message: 'PostHog: project keys resolved',
    stateUpdates: { posthog: { projectApiKeys: resolved.projectApiKeys, host: ingestHost } },
  };
}

/** True once at least one project key (per-env map or legacy single) is in state. */
function hasResolvedKey(state: SetupState): boolean {
  return Boolean(
    state.posthog?.projectApiKey ||
      (state.posthog?.projectApiKeys && Object.keys(state.posthog.projectApiKeys).length > 0),
  );
}

async function check(config: SetupConfig, state: SetupState): Promise<boolean> {
  if (!config.providers.posthog.enabled) return true;
  return hasResolvedKey(state);
}

async function pastePosthogProjectKeys(
  context: InfraProviderContext,
): Promise<CollectEnvCredentialsResult> {
  return collectEnvCredentialsForContext(context, {
    providerName: 'PostHog',
    scope: 'per-environment',
    fields: [
      {
        key: 'POSTHOG_PROJECT_API_KEY',
        label: 'Project API key (phc_… from Project Settings)',
        secret: true,
      },
    ],
  });
}

async function provisionFromPastedProjectKeys(config: SetupConfig): Promise<ProviderResult> {
  const projectApiKeys = readPerEnvProjectApiKeys(config);
  if (!projectApiKeys) {
    return {
      success: false,
      message:
        'POSTHOG_PROJECT_API_KEY still missing — add phc_… to each .env.<environment> or .setup/.setup-credentials.',
    };
  }
  const { ingestHost } = resolveHosts(config.providers.posthog.region);
  return {
    success: true,
    message: 'PostHog: project keys from env files',
    stateUpdates: { posthog: { projectApiKeys, host: ingestHost } },
  };
}

/** PostHog is configured once the personal (or project) key is in `.setup-credentials`. */
function posthogInputConfigured(): boolean {
  return Boolean(
    getEnvSetupValue('POSTHOG_PERSONAL_API_KEY') || getEnvSetupValue('POSTHOG_PROJECT_API_KEY'),
  );
}

export const setupPosthogProvider: InfraProvider = {
  key: 'posthog',
  name: 'PostHog',
  isEnabled: ({ config }) => config.providers.posthog.enabled && posthogInputConfigured(),
  disabledReason: ({ config }) =>
    !config.providers.posthog.enabled
      ? 'disabled in setup.config.json'
      : 'POSTHOG_PERSONAL_API_KEY (or POSTHOG_PROJECT_API_KEY) missing in .setup/.setup-credentials',
  preview: ({ config }) =>
    config.providers.posthog.enabled
      ? {
          detail: `Resolve POSTHOG_KEY per env (${productName(config)}-<env>, shared FE+BE)`,
          url: 'https://us.posthog.com/settings/user-api-keys',
          configKey:
            '.setup/.setup-credentials → POSTHOG_PERSONAL_API_KEY → POSTHOG_KEY / POSTHOG_HOST',
        }
      : null,
  settingsReview: ({ config }) =>
    config.providers.posthog.enabled
      ? [
          {
            bucket: 'extra',
            provider: 'PostHog',
            detail: `resolve POSTHOG_KEY per env (${productName(config)}-<env>, ${config.providers.posthog.region})`,
          },
        ]
      : [],
  describe: ({ config }) => ({
    project: productResourceName(config, resolveDefaultEnvironmentName(config)),
    organization: config.project.organization,
  }),
  inspectRemote: async ({ config }) => {
    const posthog = config.providers.posthog;
    if (!posthog.enabled) {
      return { present: false, fields: [], error: 'disabled in setup.config.json' };
    }
    const credentials = readPosthogCredentials();
    if (!credentials.personalApiKey) {
      return {
        present: false,
        fields: [],
        error: 'POSTHOG_PERSONAL_API_KEY missing in .setup/.setup-credentials',
      };
    }
    const { apiHost } = resolveHosts(posthog.region);
    try {
      const response = await setupFetch({
        name: 'PostHog',
        url: `${apiHost}/api/projects/`,
        init: { headers: { Authorization: `Bearer ${credentials.personalApiKey}` } },
      });
      if (!response.ok) {
        return { present: false, fields: [], error: `PostHog API returned ${response.status}` };
      }
      const body = (await response.json()) as { results?: PosthogProject[] };
      const names = new Set((body.results ?? []).map((project) => project.name));
      const fields = config.environments.map((environment) => {
        const expected = productResourceName(config, environment.name);
        const found = names.has(expected);
        return {
          label: `project (${environment.name})`,
          expected,
          remote: found ? expected : '—',
          matches: found,
        };
      });
      fields.push({
        label: 'region',
        expected: posthog.region,
        remote: posthog.region,
        matches: true,
      });
      return { present: fields.every((field) => field.matches), fields };
    } catch (error) {
      return {
        present: false,
        fields: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  toEnvironmentVariables: ({ config, state }, environmentName) => {
    if (!config.providers.posthog.enabled) return {};
    const override = readEnvFileValue(environmentName, 'POSTHOG_PROJECT_API_KEY');
    const key =
      override ?? state.posthog?.projectApiKeys?.[environmentName] ?? state.posthog?.projectApiKey;
    if (!key) return {};
    return {
      POSTHOG_KEY: key,
      ...(state.posthog?.host ? { POSTHOG_HOST: state.posthog.host } : {}),
    };
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'PostHog',
    enabled: setupPosthogProvider.isEnabled(context),
    enabledReason: setupPosthogProvider.disabledReason(context),
    instructions: [
      'Get a Personal API key (phx_…): https://us.posthog.com/settings/user-api-keys → "Create personal API key" → "All access".',
      'Put it in .setup/.setup-credentials as POSTHOG_PERSONAL_API_KEY=… (setup input — never used at API runtime).',
      `Setup resolves ONE shared project per environment (${context.config.environments
        .map((environment) => productResourceName(context.config, environment.name))
        .join(
          ', ',
        )}) inside org "${context.config.project.organization}", then writes POSTHOG_KEY + POSTHOG_HOST to each .env.<environment>. The same project serves the frontend.`,
      'Optional: POSTHOG_PROJECT_API_KEY=phc_… skips the API lookup; POSTHOG_PROJECT_ID pins a project.',
      'On 403 (no project:create permission), setup prompts for phc_… keys from the PostHog UI instead.',
      'When pasting keys, configure one environment at a time — skip any env you are not ready to set up yet.',
    ],
    detectStatus: () =>
      resourceStatus(hasResolvedKey(context.state), 'PostHog project key(s) in state'),
    execute: async () => {
      let result = await provision(context.config);
      if (!result.success && isPosthogPermissionError(result.message)) {
        logger.warn(
          '  PostHog API cannot create projects — paste Project API keys (phc_…) from each project in the PostHog UI.',
        );
        const pasteResult = await pastePosthogProjectKeys(context);
        assertCredentialCollectionNotAborted(pasteResult);
        result = await provisionFromPastedProjectKeys(context.config);
        if (result.success) {
          result = {
            ...result,
            message: formatEnvCredentialCollectionSummary(result.message, pasteResult),
          };
        }
      }
      if (!result.success) throw new Error(result.message);
      context.applyStateUpdates(result.stateUpdates ?? {});
      return result;
    },
    verifyState: () => ({
      ok: hasResolvedKey(context.state),
      message: context.state.posthog?.host
        ? `key(s) resolved (${context.state.posthog.host})`
        : 'no PostHog key recorded',
    }),
  }),
  check: ({ config, state }) => check(config, state),
};

export function posthogGuideConfigured(): boolean {
  return posthogInputConfigured();
}
