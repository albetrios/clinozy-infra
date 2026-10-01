/**
 * Railway image-deploy CLI.
 *
 * Pins a Railway service to a freshly built container image and triggers a
 * brand-new deployment from that image. Used by `.github/workflows/
 * reusable-railway-deploy.yml` to deploy the GHCR image that
 * reusable-docker-build-trivy.yml just built, Trivy-scanned, and pushed.
 *
 * Why not the Railway CLI?
 *   `railway redeploy` re-runs the service's previous deployment object with
 *   its existing image tag (community thread "deploy docker tag from CI"
 *   confirms `serviceInstanceRedeploy` ignores configuration changes made
 *   between deployments, and the CLI does not expose `--image`). `railway up`
 *   uploads source from the runner and lets Railway build it — that bypasses
 *   the scanned GHCR image entirely. The only reliable way to deploy a new
 *   image tag is the Railway GraphQL API: `serviceInstanceUpdate` to point
 *   the service at the new image, then `serviceInstanceDeployV2` to create a
 *   fresh deployment from the updated configuration.
 *
 * Flow:
 *   1. Resolve Railway project/environment context. The deploy workflow uses
 *      Railway project tokens, so this uses the project-token auth header and
 *      `projectToken { projectId environmentId }`; project tokens are not
 *      allowed to call `service(id)` directly.
 *   2. `serviceInstanceUpdate` with `{ source: { image } }` — works whether
 *      the service was previously image-sourced, repo-sourced, or brand new
 *      with no source at all (so this single path replaces both the
 *      `railway redeploy` steady state and the `railway up` bootstrap).
 *   3. `serviceInstanceDeployV2(serviceId, environmentId)` → deploymentId.
 *   4. Poll `deployment(id)` until a terminal status when the token scope
 *      allows deployment reads. Project tokens can trigger the deploy but may
 *      not be allowed to read deployments; in that case this tool skips the
 *      poll and the workflow's API / worker health checks remain the deploy
 *      gate.
 *
 * Inputs (all CLI flags):
 *   --service <id>                Railway service id (required).
 *   --image <ref>                 Container image, e.g.
 *                                 ghcr.io/owner/repo/clinozy-be-api:<sha> or
 *                                 ghcr.io/owner/repo/clinozy-be-api@sha256:...
 *                                 (required).
 *   --label <name>                Human label for log lines (default: service id).
 *   --environment-name <name>     Railway environment name to deploy into
 *                                 when using account-token auth.
 *                                 Defaults to process.env.ENVIRONMENT.
 *   --environment-id <id>         Skip the name lookup and use this id directly.
 *   --timeout-seconds <n>         How long to poll for terminal status
 *                                 (default 900 = 15m; covers cold builds).
 *   --poll-interval-seconds <n>   Poll cadence (default 5s).
 *   --skip-wait                   Fire-and-forget mode for diagnostics; the
 *                                 workflow should NEVER pass this so deploy
 *                                 failures actually fail the job.
 *
 * Environment:
 *   RAILWAY_TOKEN                 Railway project token. Inherited from the
 *                                 GitHub Environment in CI.
 *   RAILWAY_API_TOKEN             Optional account/workspace token override.
 *                                 Uses Bearer auth and enables deployment
 *                                 status polling.
 *   ENVIRONMENT                   GitHub Environment name (development /
 *                                 production); used as the default for
 *                                 --environment-name.
 *
 * Exit codes:
 *   0   Deployment reached SUCCESS within the timeout (or --skip-wait was set).
 *   1   Any validation, GraphQL, polling, or terminal-failure error.
 */
import { parseArgs } from 'node:util';
import * as logger from '@setup/common/logger.js';

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
const RAILWAY_GRAPHQL_TIMEOUT_MS = 20_000;
const RAILWAY_GRAPHQL_MAX_RETRY_ATTEMPTS = 4;
const RAILWAY_GRAPHQL_BASE_BACKOFF_MS = 1_000;

const DEPLOYMENT_TERMINAL_STATUSES = new Set([
  'SUCCESS',
  'FAILED',
  'CRASHED',
  'REMOVED',
  'SKIPPED',
]);

const DEPLOYMENT_SUCCESS_STATUS = 'SUCCESS';

type RailwayAuthMode = 'project' | 'bearer';

interface RailwayDeployImageOptions {
  serviceId: string;
  image: string;
  label: string;
  environmentName: string | null;
  environmentId: string | null;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
  skipWait: boolean;
}

interface RailwayGraphQLResult<T> {
  data: T;
  authMode: RailwayAuthMode;
}

interface RailwayDeploymentContext {
  projectId: string;
  environmentId: string;
  authMode: RailwayAuthMode;
}

interface RailwayEnvironment {
  id: string;
  name: string;
}

interface RailwayDeployment {
  id: string;
  status: string;
  staticUrl?: string | null;
  url?: string | null;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isRetryableHttpStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

function isRetryableNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message);
}

async function railwayGraphQL<T>({
  token,
  authMode,
  query,
  variables,
}: {
  token: string;
  authMode: RailwayAuthMode;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RAILWAY_GRAPHQL_MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(RAILWAY_API_URL, {
        method: 'POST',
        headers: buildAuthHeaders({ token, authMode }),
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(RAILWAY_GRAPHQL_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text();
        if (
          isRetryableHttpStatus(response.status) &&
          attempt < RAILWAY_GRAPHQL_MAX_RETRY_ATTEMPTS
        ) {
          const backoffMilliseconds = RAILWAY_GRAPHQL_BASE_BACKOFF_MS * 2 ** (attempt - 1);
          logger.warn(
            `Railway GraphQL retryable HTTP ${response.status} (${authMode}, attempt ${attempt}/${RAILWAY_GRAPHQL_MAX_RETRY_ATTEMPTS}); retrying in ${backoffMilliseconds}ms.`,
          );
          await sleep(backoffMilliseconds);
          continue;
        }
        throw new Error(`Railway GraphQL HTTP ${response.status}: ${body}`);
      }

      const result = (await response.json()) as {
        data?: T;
        errors?: Array<{ message: string }>;
      };

      if (result.errors?.length) {
        throw new Error(
          `Railway GraphQL errors: ${result.errors.map((entry) => entry.message).join('; ')}`,
        );
      }

      if (result.data === undefined) {
        throw new Error('Railway GraphQL returned no data and no errors.');
      }

      return result.data;
    } catch (error) {
      const retryableError = isRetryableNetworkError(error);
      if (!retryableError || attempt >= RAILWAY_GRAPHQL_MAX_RETRY_ATTEMPTS) {
        throw error;
      }

      const backoffMilliseconds = RAILWAY_GRAPHQL_BASE_BACKOFF_MS * 2 ** (attempt - 1);
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Railway GraphQL retryable network error (${authMode}, attempt ${attempt}/${RAILWAY_GRAPHQL_MAX_RETRY_ATTEMPTS}): ${errorMessage}. Retrying in ${backoffMilliseconds}ms.`,
      );
      lastError = error instanceof Error ? error : new Error(String(error));
      await sleep(backoffMilliseconds);
    }
  }

  throw lastError ?? new Error('Railway GraphQL request failed after retries.');
}

async function railwayGraphQLWithFallback<T>({
  token,
  query,
  variables,
  authModes,
}: {
  token: string;
  query: string;
  variables?: Record<string, unknown>;
  authModes: RailwayAuthMode[];
}): Promise<RailwayGraphQLResult<T>> {
  const errors: string[] = [];
  for (const authMode of authModes) {
    try {
      const data = await railwayGraphQL<T>({
        token,
        authMode,
        query,
        ...(variables !== undefined ? { variables } : {}),
      });
      return { data, authMode };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${authMode}: ${message}`);
      if (!isAuthorizationError(message)) {
        throw error;
      }
    }
  }
  throw new Error(`Railway GraphQL authorization failed (${errors.join(' | ')}).`);
}

function buildAuthHeaders({
  token,
  authMode,
}: {
  token: string;
  authMode: RailwayAuthMode;
}): Record<string, string> {
  if (authMode === 'project') {
    return { 'Project-Access-Token': token, 'Content-Type': 'application/json' };
  }
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function isAuthorizationError(message: string): boolean {
  return /not authorized|unauthorized|forbidden/i.test(message);
}

async function resolveProjectTokenContext({
  token,
}: {
  token: string;
}): Promise<RailwayDeploymentContext | null> {
  try {
    const result = await railwayGraphQL<{
      projectToken: { projectId: string; environmentId: string };
    }>({
      token,
      authMode: 'project',
      query: `
        query {
          projectToken {
            projectId
            environmentId
          }
        }
      `,
    });
    return {
      projectId: result.projectToken.projectId,
      environmentId: result.projectToken.environmentId,
      authMode: 'project',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAuthorizationError(message)) {
      return null;
    }
    throw error;
  }
}

async function resolveEnvironmentId({
  token,
  projectId,
  environmentName,
  serviceLabel,
}: {
  token: string;
  projectId: string;
  environmentName: string;
  serviceLabel: string;
}): Promise<string> {
  const { data: result } = await railwayGraphQLWithFallback<{
    project: { environments: { edges: Array<{ node: RailwayEnvironment }> } } | null;
  }>({
    token,
    query: `
      query($projectId: String!) {
        project(id: $projectId) {
          environments {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `,
    variables: { projectId },
    authModes: ['bearer'],
  });

  if (!result.project) {
    throw new Error(`Railway project ${projectId} not found while resolving ${serviceLabel}.`);
  }

  const environments = result.project.environments.edges.map((edge) => edge.node);
  const match = environments.find(
    (environment) => environment.name.toLowerCase() === environmentName.toLowerCase(),
  );

  if (!match) {
    const available = environments.map((environment) => environment.name).join(', ');
    throw new Error(
      `No Railway environment named "${environmentName}" in project ${projectId} (${serviceLabel}). Available: ${available}.`,
    );
  }

  return match.id;
}

async function resolveBearerContext({
  token,
  serviceId,
  environmentId,
  environmentName,
}: {
  token: string;
  serviceId: string;
  environmentId: string | null;
  environmentName: string | null;
}): Promise<RailwayDeploymentContext> {
  const { data: serviceResult } = await railwayGraphQLWithFallback<{
    service: { id: string; name: string; projectId: string } | null;
  }>({
    token,
    query: `
      query($serviceId: String!) {
        service(id: $serviceId) {
          id
          name
          projectId
        }
      }
    `,
    variables: { serviceId },
    authModes: ['bearer'],
  });

  if (!serviceResult.service) {
    throw new Error(`Railway service ${serviceId} not found (or token lacks access).`);
  }

  let resolvedEnvironmentId = environmentId;
  if (!resolvedEnvironmentId) {
    if (!environmentName) {
      throw new Error('Either --environment-id or --environment-name is required for Bearer auth.');
    }
    logger.info(
      `  Resolving Railway environment "${environmentName}" in project ${serviceResult.service.projectId}.`,
    );
    resolvedEnvironmentId = await resolveEnvironmentId({
      token,
      projectId: serviceResult.service.projectId,
      environmentName,
      serviceLabel: serviceResult.service.name,
    });
  }

  logger.success(
    `  Service: ${serviceResult.service.name} (id=${serviceResult.service.id}, projectId=${serviceResult.service.projectId})`,
  );
  return {
    projectId: serviceResult.service.projectId,
    environmentId: resolvedEnvironmentId,
    authMode: 'bearer',
  };
}

async function updateServiceImage({
  token,
  authMode,
  serviceId,
  environmentId,
  image,
}: {
  token: string;
  authMode: RailwayAuthMode;
  serviceId: string;
  environmentId: string;
  image: string;
}): Promise<void> {
  await railwayGraphQL<{ serviceInstanceUpdate: boolean | null }>({
    token,
    authMode,
    query: `
      mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(
          serviceId: $serviceId
          environmentId: $environmentId
          input: $input
        )
      }
    `,
    variables: {
      serviceId,
      environmentId,
      input: { source: { image } },
    },
  });
}

async function triggerDeployment({
  token,
  authMode,
  serviceId,
  environmentId,
}: {
  token: string;
  authMode: RailwayAuthMode;
  serviceId: string;
  environmentId: string;
}): Promise<string> {
  const result = await railwayGraphQL<{ serviceInstanceDeployV2: string }>({
    token,
    authMode,
    query: `
      mutation($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
      }
    `,
    variables: { serviceId, environmentId },
  });

  if (!result.serviceInstanceDeployV2) {
    throw new Error('serviceInstanceDeployV2 returned no deployment id.');
  }
  return result.serviceInstanceDeployV2;
}

async function fetchDeployment({
  token,
  authMode,
  deploymentId,
}: {
  token: string;
  authMode: RailwayAuthMode;
  deploymentId: string;
}): Promise<RailwayDeployment> {
  const result = await railwayGraphQL<{ deployment: RailwayDeployment | null }>({
    token,
    authMode,
    query: `
      query($deploymentId: String!) {
        deployment(id: $deploymentId) {
          id
          status
          staticUrl
          url
        }
      }
    `,
    variables: { deploymentId },
  });

  if (!result.deployment) {
    throw new Error(`Railway deployment ${deploymentId} not found.`);
  }
  return result.deployment;
}

async function waitForTerminalStatus({
  token,
  authMode,
  deploymentId,
  label,
  timeoutSeconds,
  pollIntervalSeconds,
}: {
  token: string;
  authMode: RailwayAuthMode;
  deploymentId: string;
  label: string;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
}): Promise<RailwayDeployment> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStatus = '';
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    let deployment: RailwayDeployment;
    try {
      deployment = await fetchDeployment({ token, authMode, deploymentId });
    } catch (error) {
      // Railway occasionally returns transient 5xx during deploys. Don't
      // fail the whole job on a single blip — log and keep polling until
      // the timeout. This mirrors the retry behaviour already used by the
      // workflow's variables push.
      const message = error instanceof Error ? error.message : String(error);
      if (isAuthorizationError(message)) {
        throw error;
      }
      logger.warn(`  ${label}: poll attempt ${attempt} errored (${message}); retrying.`);
      await sleep(pollIntervalSeconds * 1000);
      continue;
    }

    if (deployment.status !== lastStatus) {
      logger.info(`  ${label}: deployment ${deployment.id} → ${deployment.status}`);
      lastStatus = deployment.status;
    }

    if (DEPLOYMENT_TERMINAL_STATUSES.has(deployment.status)) {
      return deployment;
    }

    await sleep(pollIntervalSeconds * 1000);
  }

  throw new Error(
    `Timeout: deployment ${deploymentId} for ${label} did not reach a terminal status within ${timeoutSeconds}s (last status: ${lastStatus || 'unknown'}).`,
  );
}

function parseOptions(): RailwayDeployImageOptions {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      service: { type: 'string' },
      image: { type: 'string' },
      label: { type: 'string' },
      'environment-name': { type: 'string' },
      'environment-id': { type: 'string' },
      'timeout-seconds': { type: 'string' },
      'poll-interval-seconds': { type: 'string' },
      'skip-wait': { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const serviceId = (values.service ?? '').trim();
  const image = (values.image ?? '').trim();
  const environmentNameInput = (values['environment-name'] ?? process.env.ENVIRONMENT ?? '').trim();
  const environmentId = (values['environment-id'] ?? '').trim();
  const label = (values.label ?? serviceId).trim();
  const timeoutSeconds = Number.parseInt(values['timeout-seconds'] ?? '900', 10);
  const pollIntervalSeconds = Number.parseInt(values['poll-interval-seconds'] ?? '5', 10);

  if (!serviceId) throw new Error('--service <id> is required.');
  if (!image) throw new Error('--image <ref> is required.');
  // Project-token auth resolves the scoped environment through
  // `projectToken { environmentId }`, so environment name/id is only required
  // later if this token turns out to be an account/workspace token.
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`Invalid --timeout-seconds: ${values['timeout-seconds']}`);
  }
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new Error(`Invalid --poll-interval-seconds: ${values['poll-interval-seconds']}`);
  }

  return {
    serviceId,
    image,
    label,
    environmentName: environmentNameInput || null,
    environmentId: environmentId || null,
    timeoutSeconds,
    pollIntervalSeconds,
    skipWait: values['skip-wait'] === true,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const token = (
    process.env.RAILWAY_API_TOKEN ??
    process.env.RAILWAY_GRAPHQL_TOKEN ??
    process.env.RAILWAY_TOKEN ??
    ''
  ).trim();
  if (!token) {
    throw new Error(
      'RAILWAY_TOKEN is not set. Export it from the GitHub Environment before running this tool.',
    );
  }

  logger.info(`Deploy ${options.label}: resolving Railway deployment context.`);
  let deploymentContext = await resolveProjectTokenContext({ token });
  if (deploymentContext) {
    logger.success(
      `  Project-token scope: projectId=${deploymentContext.projectId}, environmentId=${deploymentContext.environmentId}`,
    );
  } else {
    logger.info('  Project-token context unavailable; trying Bearer auth.');
    deploymentContext = await resolveBearerContext({
      token,
      serviceId: options.serviceId,
      environmentId: options.environmentId,
      environmentName: options.environmentName,
    });
    logger.success(
      `  Bearer-token scope: projectId=${deploymentContext.projectId}, environmentId=${deploymentContext.environmentId}`,
    );
  }

  logger.info(`  Pinning service source to image: ${options.image}`);
  await updateServiceImage({
    token,
    authMode: deploymentContext.authMode,
    serviceId: options.serviceId,
    environmentId: deploymentContext.environmentId,
    image: options.image,
  });
  logger.success('  serviceInstanceUpdate: source.image set.');

  logger.info('  Triggering serviceInstanceDeployV2 to create a fresh deployment.');
  const deploymentId = await triggerDeployment({
    token,
    authMode: deploymentContext.authMode,
    serviceId: options.serviceId,
    environmentId: deploymentContext.environmentId,
  });
  logger.success(`  Deployment requested. id=${deploymentId}`);

  if (options.skipWait) {
    logger.warn(
      `  --skip-wait set; not polling for terminal status. Deployment ${deploymentId} may still fail asynchronously.`,
    );
    return;
  }

  logger.info(
    `  Waiting for deployment ${deploymentId} to reach a terminal status (timeout ${options.timeoutSeconds}s).`,
  );
  let finalDeployment: RailwayDeployment | null = null;
  try {
    finalDeployment = await waitForTerminalStatus({
      token,
      authMode: deploymentContext.authMode,
      deploymentId,
      label: options.label,
      timeoutSeconds: options.timeoutSeconds,
      pollIntervalSeconds: options.pollIntervalSeconds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (deploymentContext.authMode === 'project' && isAuthorizationError(message)) {
      logger.warn(
        `  ${options.label}: project token cannot read deployment status (${message}). Skipping GraphQL polling; workflow health checks remain the deployment gate.`,
      );
      return;
    }
    throw error;
  }

  if (finalDeployment.status !== DEPLOYMENT_SUCCESS_STATUS) {
    throw new Error(
      `Deployment ${deploymentId} for ${options.label} ended in non-success status: ${finalDeployment.status}.`,
    );
  }

  const accessUrl = finalDeployment.staticUrl ?? finalDeployment.url ?? '(no public url)';
  logger.success(`  ${options.label}: deployment ${deploymentId} SUCCESS (${accessUrl}).`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message);
  process.exit(1);
});
