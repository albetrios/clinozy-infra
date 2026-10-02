/**
 * Railway Redis provider for `pnpm setup:infra`.
 *
 * Deploys the Railway "redis" database template and records its connection URL to state.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only (via build-env-vars), never printed to the
 * console; setup secret files are gitignored and written owner-only. See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import * as logger from '@setup/common/logger.js';
import { isSecretFilled } from '@setup/common/secrets.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import type {
  InfraProvider,
  InfraProviderContext,
  ProviderResult,
  SetupConfig,
  SetupSecrets,
  SetupState,
} from '@setup/common/types.js';

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
const REDIS_TEMPLATE_CODE = 'redis';
const REDIS_PORT = 6379;
/**
 * The Railway `redis` template names its service "Redis", but a second deploy into the same
 * project gets a suffixed name (production's became "Redis-ufVc"), and Railway's private DNS
 * follows the service name (`redis-ufvc.railway.internal`). So the host is read from the
 * service itself — its rendered REDISHOST / RAILWAY_PRIVATE_DOMAIN — never assumed. The URL is
 * only routable inside Railway's private network; local `pnpm dev` cannot reach it.
 */
const RAILWAY_PRIVATE_DNS_SUFFIX = '.railway.internal';
/** Default service name created by the `redis` template. */
const REDIS_SERVICE_NAME_DEFAULT = 'Redis';
/** Key under which the service is recorded in `state.railway.environments.<env>.services`. */
const REDIS_SERVICE_STATE_KEY = 'redis';
const WORKFLOW_POLL_INTERVAL_MS = 2_000;
const WORKFLOW_POLL_TIMEOUT_MS = 180_000;
const SERVICE_DISCOVERY_TIMEOUT_MS = 60_000;
const SERVICE_DISCOVERY_INTERVAL_MS = 2_000;

async function railwayGraphQL<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await setupFetch({
    name: 'Railway Redis',
    url: RAILWAY_API_URL,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Railway GraphQL failed (${response.status}): ${errorBody}`);
  }

  const result = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (result.errors?.length) {
    throw new Error(
      `Railway GraphQL errors: ${result.errors.map((error) => error.message).join(', ')}`,
    );
  }

  return result.data as T;
}

/** Password + private host of one environment's Redis service, as Railway renders them. */
export interface RedisConnection {
  readonly password: string;
  readonly host: string;
}

export function buildRailwayRedisUrl(connection: RedisConnection): string {
  return `redis://default:${encodeURIComponent(connection.password)}@${connection.host}:${REDIS_PORT}`;
}

function buildRailwayPrivateEndpoint(connection: RedisConnection): string {
  return `${connection.host}:${REDIS_PORT}`;
}

/**
 * The service's private host from its rendered variables: REDISHOST (the template's own), else
 * RAILWAY_PRIVATE_DOMAIN, else the private-DNS name Railway derives from the service name.
 */
export function redisPrivateHost(variables: Record<string, string>, serviceName: string): string {
  const rendered = variables.REDISHOST || variables.RAILWAY_PRIVATE_DOMAIN;
  if (rendered && !rendered.includes('${{')) return rendered;
  return `${serviceName.toLowerCase()}${RAILWAY_PRIVATE_DNS_SUFFIX}`;
}

function hasUsableRedisState(state: SetupState, environmentName: string): boolean {
  const database = state.redis?.databases?.[environmentName];
  if (!(database?.redisUrl && database.databaseId)) return false;
  if (database.redisUrl.includes('${{')) return false;
  return database.redisUrl.includes(`${RAILWAY_PRIVATE_DNS_SUFFIX}:`);
}

async function resolveWorkspaceId(token: string, projectId: string): Promise<string | undefined> {
  const result = await railwayGraphQL<{ project?: { teamId?: string | null } }>(
    token,
    `
    query Project($id: String!) {
      project(id: $id) {
        teamId
      }
    }
  `,
    { id: projectId },
  );
  return result.project?.teamId ?? undefined;
}

interface RedisTemplateDescriptor {
  templateId: string;
  serializedConfig: unknown;
}

async function fetchRedisTemplate(token: string): Promise<RedisTemplateDescriptor> {
  const result = await railwayGraphQL<{
    template?: { id: string; serializedConfig: unknown } | null;
  }>(
    token,
    `
    query RedisTemplate($code: String!) {
      template(code: $code) {
        id
        serializedConfig
      }
    }
  `,
    { code: REDIS_TEMPLATE_CODE },
  );
  if (!result.template?.id) {
    throw new Error(
      `Railway Redis: template "${REDIS_TEMPLATE_CODE}" not found in Railway marketplace.`,
    );
  }
  return {
    templateId: result.template.id,
    serializedConfig: result.template.serializedConfig,
  };
}

interface DeployTemplateOptions {
  token: string;
  template: RedisTemplateDescriptor;
  projectId: string;
  environmentId: string;
  workspaceId?: string;
}

async function deployRedisTemplate(options: DeployTemplateOptions): Promise<string> {
  const result = await railwayGraphQL<{
    templateDeployV2?: { workflowId?: string | null } | null;
  }>(
    options.token,
    `
    mutation DeployRedisTemplate($input: TemplateDeployV2Input!) {
      templateDeployV2(input: $input) {
        workflowId
      }
    }
  `,
    {
      input: {
        templateId: options.template.templateId,
        serializedConfig: options.template.serializedConfig,
        projectId: options.projectId,
        environmentId: options.environmentId,
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      },
    },
  );
  const workflowId = result.templateDeployV2?.workflowId;
  if (!workflowId) {
    throw new Error('Railway Redis: templateDeployV2 did not return a workflowId.');
  }
  return workflowId;
}

type WorkflowStatus = 'NotFound' | 'Running' | 'Complete' | 'Error';

async function fetchWorkflowStatus(token: string, workflowId: string): Promise<WorkflowStatus> {
  const result = await railwayGraphQL<{
    workflowStatus?: { status?: WorkflowStatus } | WorkflowStatus | null;
  }>(
    token,
    `
    query WorkflowStatus($workflowId: String!) {
      workflowStatus(workflowId: $workflowId) {
        status
      }
    }
  `,
    { workflowId },
  );
  const raw = result.workflowStatus;
  if (raw === null || raw === undefined) return 'NotFound';
  if (typeof raw === 'string') return raw;
  return raw.status ?? 'NotFound';
}

async function waitForWorkflow(token: string, workflowId: string): Promise<void> {
  const deadline = Date.now() + WORKFLOW_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await fetchWorkflowStatus(token, workflowId);
    if (status === 'Complete') return;
    if (status === 'Error') {
      throw new Error(`Railway Redis: template deploy workflow ${workflowId} failed.`);
    }
    await delay(WORKFLOW_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Railway Redis: template deploy workflow ${workflowId} did not complete within ${WORKFLOW_POLL_TIMEOUT_MS / 1000}s.`,
  );
}

interface EnvironmentService {
  serviceId: string;
  serviceName: string;
}

async function fetchEnvironmentServices(
  token: string,
  projectId: string,
  environmentId: string,
): Promise<EnvironmentService[]> {
  const result = await railwayGraphQL<{
    project?: {
      environments?: {
        edges?: Array<{
          node?: {
            id: string;
            serviceInstances?: {
              edges?: Array<{ node?: { serviceId: string; serviceName: string } }>;
            };
          };
        }>;
      };
    };
  }>(
    token,
    `
    query EnvironmentServices($id: String!) {
      project(id: $id) {
        environments {
          edges {
            node {
              id
              serviceInstances {
                edges {
                  node {
                    serviceId
                    serviceName
                  }
                }
              }
            }
          }
        }
      }
    }
  `,
    { id: projectId },
  );
  const environment = (result.project?.environments?.edges ?? [])
    .map((edge) => edge.node)
    .find((node) => node?.id === environmentId);
  return (environment?.serviceInstances?.edges ?? [])
    .map((edge) => edge.node)
    .filter((node): node is EnvironmentService => node !== undefined);
}

function isRedisServiceName(serviceName: string): boolean {
  const normalizedServiceName = serviceName.toLowerCase();
  const normalizedDefaultName = REDIS_SERVICE_NAME_DEFAULT.toLowerCase();
  return (
    normalizedServiceName === normalizedDefaultName ||
    normalizedServiceName.startsWith(`${normalizedDefaultName}-`)
  );
}

async function discoverRedisService(options: {
  token: string;
  projectId: string;
  environmentId: string;
  knownServiceIds: Set<string>;
}): Promise<EnvironmentService> {
  const deadline = Date.now() + SERVICE_DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const services = await fetchEnvironmentServices(
      options.token,
      options.projectId,
      options.environmentId,
    );
    const candidate = services.find(
      (service) =>
        isRedisServiceName(service.serviceName) && !options.knownServiceIds.has(service.serviceId),
    );
    if (candidate) return candidate;
    await delay(SERVICE_DISCOVERY_INTERVAL_MS);
  }
  throw new Error(
    `Railway Redis: did not discover a new redis service in environment ${options.environmentId} after template deploy.`,
  );
}

async function fetchServiceVariables(options: {
  token: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
}): Promise<Record<string, string>> {
  const result = await railwayGraphQL<{ variables?: Record<string, string> | null }>(
    options.token,
    `
    query ServiceVariables($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
    }
  `,
    {
      projectId: options.projectId,
      environmentId: options.environmentId,
      serviceId: options.serviceId,
    },
  );
  return result.variables ?? {};
}

async function readRedisConnection(options: {
  token: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  serviceName: string;
}): Promise<RedisConnection> {
  const variables = await fetchServiceVariables(options);
  const password = variables.REDIS_PASSWORD;
  if (!password) {
    throw new Error(
      `Railway Redis: REDIS_PASSWORD is missing on the template-created service ${options.serviceId}.`,
    );
  }
  return { password, host: redisPrivateHost(variables, options.serviceName) };
}

interface AdoptableRedisService {
  serviceId: string;
  serviceName: string;
  connection: RedisConnection;
}

/**
 * Look up an existing redis-named service in the given environment and, if one
 * is found, read its REDIS_PASSWORD so the caller can adopt it into local
 * state instead of provisioning a fresh template (which would create a
 * duplicate service in the Railway project).
 *
 * Returns `undefined` when no redis service exists yet. Throws only on a
 * real Railway API error — a service present but missing REDIS_PASSWORD is
 * also returned as `undefined` so the caller can fall back to template
 * deploy rather than block the whole run.
 */
async function findAdoptableRedisService(options: {
  token: string;
  projectId: string;
  environmentId: string;
}): Promise<AdoptableRedisService | undefined> {
  const services = await fetchEnvironmentServices(
    options.token,
    options.projectId,
    options.environmentId,
  );
  const candidates = services.filter((service) => isRedisServiceName(service.serviceName));
  for (const candidate of candidates) {
    try {
      const variables = await fetchServiceVariables({
        token: options.token,
        projectId: options.projectId,
        environmentId: options.environmentId,
        serviceId: candidate.serviceId,
      });
      const password = variables.REDIS_PASSWORD;
      if (password) {
        return {
          serviceId: candidate.serviceId,
          serviceName: candidate.serviceName,
          connection: { password, host: redisPrivateHost(variables, candidate.serviceName) },
        };
      }
    } catch {
      // candidate unreadable — try the next one
    }
  }
  return undefined;
}

async function applyResourceOverrides(options: {
  token: string;
  serviceId: string;
  environmentId: string;
  config: SetupConfig['providers']['railwayRedis'];
}): Promise<void> {
  const { region } = options.config;
  if (!region) return;
  await railwayGraphQL<{ serviceInstanceUpdate: boolean | null }>(
    options.token,
    `
    mutation ServiceInstanceUpdate(
      $serviceId: String!
      $environmentId: String!
      $input: ServiceInstanceUpdateInput!
    ) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }
  `,
    {
      serviceId: options.serviceId,
      environmentId: options.environmentId,
      input: {
        multiRegionConfig: {
          [region]: { numReplicas: 1 },
        },
      },
    },
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function provision(
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
  environments: string[],
  applyStateUpdates?: (updates: Partial<SetupState>) => void,
): Promise<ProviderResult> {
  if (!isSecretFilled(secrets.railway.apiToken)) {
    return {
      success: false,
      message: 'Railway Redis: RAILWAY_API_TOKEN must be set in .setup/.setup-credentials.',
    };
  }
  if (!state.railway?.projectId) {
    return {
      success: false,
      message: 'Railway Redis: Railway project state missing. Run the Railway provider first.',
    };
  }

  const token = secrets.railway.apiToken as string;
  const railwayState = state.railway;
  const projectId = railwayState.projectId;

  const databases: NonNullable<SetupState['redis']>['databases'] = {
    ...(state.redis?.databases ?? {}),
  };
  const railwayEnvironments: NonNullable<NonNullable<SetupState['railway']>['environments']> = {
    ...(railwayState.environments ?? {}),
  };

  const recordEnvironmentState = (
    environmentName: string,
    environmentId: string,
    existingServices: NonNullable<
      NonNullable<SetupState['railway']>['environments']
    >[string]['services'],
    serviceId: string,
    connection: RedisConnection,
  ): void => {
    railwayEnvironments[environmentName] = {
      environmentId,
      services: {
        ...existingServices,
        [REDIS_SERVICE_STATE_KEY]: { serviceId, environmentId },
      },
    };
    databases[environmentName] = {
      databaseId: `${serviceId}:${environmentId}`,
      publicEndpoint: buildRailwayPrivateEndpoint(connection),
      redisUrl: buildRailwayRedisUrl(connection),
    };
    applyStateUpdates?.({
      redis: { subscriptionId: 0, databases },
      // Spread the latest railway state so prior-provider fields (notably
      // `environmentTokens` minted by the Railway provider, and `version`) are
      // preserved when we replace projectId/services/environments here. Object.assign
      // in the orchestrator is shallow, so a partial object would clobber the rest.
      railway: {
        ...state.railway,
        projectId,
        services: railwayState.services ?? {},
        environments: railwayEnvironments,
      },
    });
  };

  let template: RedisTemplateDescriptor | undefined;
  let workspaceId: string | undefined;

  const provisioned: string[] = [];
  const adopted: string[] = [];
  const skipped: string[] = [];

  for (const environmentName of environments) {
    const environmentState = railwayEnvironments[environmentName];
    if (!environmentState) {
      return {
        success: false,
        message: `Railway Redis: Railway environment "${environmentName}" is missing from state. Run the Railway provider first.`,
      };
    }

    if (hasUsableRedisState(state, environmentName)) {
      skipped.push(environmentName);
      logger.info(
        `Railway Redis (${environmentName}): already provisioned in state — skipping template deploy.`,
      );
      continue;
    }

    // Before deploying a fresh template, see if Railway already has a Redis
    // service in this environment (state may have been wiped, or a previous
    // run may have deployed but failed to persist state). Adopting it avoids
    // creating a duplicate service that would never be cleaned up
    // automatically (setup:infra never deletes resources).
    const existingRedis = await findAdoptableRedisService({
      token,
      projectId,
      environmentId: environmentState.environmentId,
    });
    if (existingRedis) {
      recordEnvironmentState(
        environmentName,
        environmentState.environmentId,
        environmentState.services,
        existingRedis.serviceId,
        existingRedis.connection,
      );
      adopted.push(environmentName);
      logger.success(
        `Railway Redis (${environmentName}): adopted existing service "${existingRedis.serviceName}" (${existingRedis.serviceId}) — recorded in state, skipping template deploy.`,
      );
      continue;
    }

    template ??= await fetchRedisTemplate(token);
    workspaceId ??= await resolveWorkspaceId(token, projectId);

    const spinner = logger.startSpinner(
      `Deploying Railway Redis database template (${environmentName})...`,
    );

    try {
      const knownServiceIds = new Set(
        Object.values(environmentState.services)
          .map((service) => service.serviceId)
          .filter((serviceId): serviceId is string => Boolean(serviceId)),
      );

      const workflowId = await deployRedisTemplate({
        token,
        template,
        projectId,
        environmentId: environmentState.environmentId,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });
      await waitForWorkflow(token, workflowId);

      const discovered = await discoverRedisService({
        token,
        projectId,
        environmentId: environmentState.environmentId,
        knownServiceIds,
      });

      await applyResourceOverrides({
        token,
        serviceId: discovered.serviceId,
        environmentId: environmentState.environmentId,
        config: config.providers.railwayRedis,
      });

      const connection = await readRedisConnection({
        token,
        projectId,
        environmentId: environmentState.environmentId,
        serviceId: discovered.serviceId,
        serviceName: discovered.serviceName,
      });

      recordEnvironmentState(
        environmentName,
        environmentState.environmentId,
        environmentState.services,
        discovered.serviceId,
        connection,
      );

      provisioned.push(environmentName);
      logger.stopSpinner(
        spinner,
        `Railway Redis (${environmentName}) deployed from template "${REDIS_TEMPLATE_CODE}" as service "${discovered.serviceName}".`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.stopSpinner(spinner, `Railway Redis (${environmentName}) failed: ${message}`, 'fail');
      return {
        success: false,
        message,
        stateUpdates: {
          redis: { subscriptionId: 0, databases },
          railway: { ...state.railway, environments: railwayEnvironments },
        },
      };
    }
  }

  const messageParts: string[] = [];
  if (provisioned.length > 0) {
    messageParts.push(`provisioned ${provisioned.join(', ')}`);
  }
  if (adopted.length > 0) {
    messageParts.push(`adopted existing ${adopted.join(', ')}`);
  }
  if (skipped.length > 0) {
    messageParts.push(`skipped (already in state) ${skipped.join(', ')}`);
  }

  return {
    success: true,
    message: `Railway Redis: ${messageParts.join('; ') || 'no environments needed provisioning'}.`,
    stateUpdates: {
      redis: { subscriptionId: 0, databases },
      railway: { ...state.railway, environments: railwayEnvironments },
    },
  };
}

function getRedisServiceState(
  state: SetupState,
  environmentName: string,
): { environmentId: string; serviceId: string } | undefined {
  const environmentState = state.railway?.environments?.[environmentName];
  const redisServiceState = environmentState?.services[REDIS_SERVICE_STATE_KEY];
  if (!(environmentState && redisServiceState?.serviceId)) return undefined;
  return {
    environmentId: redisServiceState.environmentId ?? environmentState.environmentId,
    serviceId: redisServiceState.serviceId,
  };
}

function allEnvironmentsHaveRedis(environments: string[], state: SetupState): boolean {
  if (!state.redis?.databases) return false;
  return environments.every((environmentName) => {
    const database = state.redis?.databases?.[environmentName];
    const serviceState = getRedisServiceState(state, environmentName);
    if (!(serviceState?.serviceId && database?.redisUrl)) return false;
    if (database.databaseId !== `${serviceState.serviceId}:${serviceState.environmentId}`) {
      return false;
    }
    return hasUsableRedisState(state, environmentName);
  });
}

export const setupRailwayRedisProvider: InfraProvider = {
  key: 'railway-redis',
  name: 'Railway Redis',
  isEnabled: ({ config, secrets }) =>
    config.providers.railwayRedis.enabled && isSecretFilled(secrets.railway.apiToken),
  disabledReason: ({ config }) =>
    !config.providers.railwayRedis.enabled
      ? 'disabled in setup.config.json'
      : 'RAILWAY_API_TOKEN missing in .setup/.setup-credentials',
  preview: ({ config }) =>
    config.providers.railwayRedis.enabled
      ? {
          detail: `Railway "${REDIS_TEMPLATE_CODE}" database template${
            config.providers.railwayRedis.region
              ? `, replica region ${config.providers.railwayRedis.region}`
              : ''
          }`,
          url: 'https://railway.com/account/tokens',
          configKey: 'RAILWAY_API_TOKEN',
        }
      : null,
  settingsReview: ({ config, environments }) =>
    config.providers.railwayRedis.enabled
      ? [
          {
            bucket: 'resource',
            provider: 'Railway Redis',
            detail: `${environments.length} Redis database(s) from Railway template "${REDIS_TEMPLATE_CODE}"${
              config.providers.railwayRedis.region
                ? `, region ${config.providers.railwayRedis.region}`
                : ''
            }`,
          },
        ]
      : [],
  describe: ({ config, environments }) => ({
    project: config.project.name,
    environments,
    services: ['redis (database template)'],
    planGroup: 'Railway',
  }),
  inspectRemote: async ({ config, secrets, environments }) => {
    if (!config.providers.railwayRedis.enabled) {
      return { present: false, fields: [], error: 'disabled in setup.config.json' };
    }
    const token = secrets.railway.apiToken ?? '';
    if (!token)
      return {
        present: false,
        fields: [],
        error: 'RAILWAY_API_TOKEN missing in .setup/.setup-credentials',
      };
    const projectName = config.project.name;
    try {
      // Find the project by name (independent of local state), then read services per env.
      const projectList = await railwayGraphQL<{
        projects?: { edges?: Array<{ node?: { id: string; name: string } }> };
      }>(token, 'query { projects { edges { node { id name } } } }');
      const projectId = projectList.projects?.edges
        ?.map((edge) => edge.node)
        .find((project) => project?.name === projectName)?.id;
      if (!projectId) {
        return {
          present: false,
          fields: [{ label: 'project', expected: projectName, remote: '—', matches: false }],
        };
      }
      const detail = await railwayGraphQL<{
        project?: {
          environments?: {
            edges?: Array<{
              node?: {
                name: string;
                serviceInstances?: { edges?: Array<{ node?: { serviceName: string } }> };
              };
            }>;
          };
        };
      }>(
        token,
        `query($id: String!) { project(id: $id) { environments { edges { node { name serviceInstances { edges { node { serviceName } } } } } } } }`,
        { id: projectId },
      );
      const servicesByEnvironment = new Map<string, string[]>();
      for (const edge of detail.project?.environments?.edges ?? []) {
        const node = edge.node;
        if (!node) continue;
        servicesByEnvironment.set(
          node.name,
          (node.serviceInstances?.edges ?? []).map((service) => service.node?.serviceName ?? ''),
        );
      }
      const fields = [];
      let anyPresent = false;
      for (const environmentName of environments) {
        const present = (servicesByEnvironment.get(environmentName) ?? []).some((name) =>
          name.toLowerCase().includes('redis'),
        );
        fields.push({
          label: `redis service (${environmentName})`,
          expected: REDIS_SERVICE_NAME_DEFAULT,
          remote: present ? REDIS_SERVICE_NAME_DEFAULT : '—',
          matches: present,
        });
        anyPresent = anyPresent || present;
      }
      return { present: anyPresent, fields };
    } catch (error) {
      return {
        present: false,
        fields: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  toEnvironmentVariables: ({ state }, environmentName) => {
    const url = state.redis?.databases?.[environmentName]?.redisUrl;
    return url ? { REDIS_URL: url } : {};
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'Railway Redis',
    enabled: setupRailwayRedisProvider.isEnabled(context),
    enabledReason: setupRailwayRedisProvider.disabledReason(context),
    instructions: [
      `For each environment (${context.environments.join(', ')}): adopt the existing redis-named service if one already exists in Railway, otherwise deploy Railway's "${REDIS_TEMPLATE_CODE}" database template (templateDeployV2).`,
      'Will read REDIS_PASSWORD from the adopted/created service and record a concrete REDIS_URL on the in-memory run state after each environment (so the env-file writer picks it up before the process exits).',
      context.config.providers.railwayRedis.region
        ? `Will apply replica region "${context.config.providers.railwayRedis.region}" to newly-created Redis services via serviceInstanceUpdate.`
        : 'Will use Railway default region for newly-created Redis services (no region override configured).',
    ],
    detectStatus: () =>
      resourceStatus(
        allEnvironmentsHaveRedis(context.environments, context.state),
        'all environments have Railway Redis services + URLs in state',
      ),
    execute: async () => {
      const result = await provision(
        context.config,
        context.secrets,
        context.state,
        context.environments,
        context.applyStateUpdates,
      );
      if (result.stateUpdates && Object.keys(result.stateUpdates).length > 0) {
        context.applyStateUpdates(result.stateUpdates);
      }
      if (!result.success) throw new Error(result.message);
      return result;
    },
    verifyState: () => ({
      ok: allEnvironmentsHaveRedis(context.environments, context.state),
      message: context.state.redis
        ? `Redis URL recorded for ${Object.keys(context.state.redis.databases).length} environment(s)`
        : 'no Redis state recorded',
    }),
  }),
  detectRemote: async ({ secrets, state, environments, applyStateUpdates }) => {
    const adopted: Record<string, string> = {};
    if (!(isSecretFilled(secrets.railway.apiToken) && state.railway?.projectId)) {
      return adopted;
    }
    const token = secrets.railway.apiToken as string;
    const projectId = state.railway.projectId;

    const databases: NonNullable<SetupState['redis']>['databases'] = {
      ...(state.redis?.databases ?? {}),
    };
    const railwayEnvironments: NonNullable<NonNullable<SetupState['railway']>['environments']> = {
      ...(state.railway.environments ?? {}),
    };

    for (const environmentName of environments) {
      if (hasUsableRedisState(state, environmentName)) continue;
      const environmentState = railwayEnvironments[environmentName];
      if (!environmentState) continue;

      try {
        const existingRedis = await findAdoptableRedisService({
          token,
          projectId,
          environmentId: environmentState.environmentId,
        });
        if (!existingRedis) continue;

        railwayEnvironments[environmentName] = {
          environmentId: environmentState.environmentId,
          services: {
            ...environmentState.services,
            [REDIS_SERVICE_STATE_KEY]: {
              serviceId: existingRedis.serviceId,
              environmentId: environmentState.environmentId,
            },
          },
        };
        databases[environmentName] = {
          databaseId: `${existingRedis.serviceId}:${environmentState.environmentId}`,
          publicEndpoint: buildRailwayPrivateEndpoint(existingRedis.connection),
          redisUrl: buildRailwayRedisUrl(existingRedis.connection),
        };

        applyStateUpdates({
          redis: { subscriptionId: 0, databases },
          railway: { ...state.railway, environments: railwayEnvironments },
        });
        adopted[environmentName] = `${existingRedis.serviceName} (${existingRedis.serviceId})`;
      } catch {
        // single-environment lookup failure should not block the rest
      }
    }
    return adopted;
  },
  check: ({ state, environments }) =>
    Promise.resolve(allEnvironmentsHaveRedis(environments, state)),
  deleteInstructions: ({ state }) => {
    const databases = state.redis?.databases;
    if (!databases || Object.keys(databases).length === 0) return [];
    return [
      {
        provider: 'Railway Redis',
        dashboardUrl: state.railway?.projectId
          ? `https://railway.app/project/${state.railway.projectId}`
          : 'https://railway.app/dashboard',
        steps: [
          'Open the Railway project and select the Redis database service (created from the "redis" template).',
          'Delete the Redis service, or delete the whole project if setup:infra created it only for this app.',
        ],
        resources: Object.entries(databases).map(([environmentName, database]) => ({
          label: `Redis database (${environmentName})`,
          identifier: String(database.databaseId),
        })),
      },
    ];
  },
};
