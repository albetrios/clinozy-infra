/**
 * Postman provider for `pnpm setup:infra`.
 *
 * One input only — POSTMAN_API_KEY (an account-wide setup credential in `.setup-credentials`,
 * read via `secrets.postman.apiKey`). The script then does everything via the Postman API: finds
 * or CREATES one workspace named after the project (`POST /workspaces`), and generates + uploads a
 * collection PER ENVIRONMENT (`<project>-<env>`, each with that env's API base URL baked in). No
 * POSTMAN_WORKSPACE_ID input — the workspace id is created/resolved and written back to each
 * `.env.<environment>` as an output; per-env collection ids are recorded in state.
 *
 * Postman teams/organizations are NOT API-creatable (dashboard/billing-level); the API token is
 * issued under your existing account/team, and everything below it (workspace + collection) is
 * created here.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: POSTMAN_API_KEY lives in `.setup-credentials` (gitignored, unreadable by the agent via
 * the deny-read guard) and is never printed to the console. See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import { execSync } from 'node:child_process';
import { targetRoot } from '@setup/common/paths.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resourceStatus } from '@setup/common/interactive-step.js';
import * as logger from '@setup/common/logger.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import type {
  InfraProvider,
  InfraProviderContext,
  ProviderResult,
  SetupConfig,
  SetupSecrets,
  SetupState,
} from '@setup/common/types.js';
import { buildEnvironmentVariables } from '@setup/envs/build-env-vars.js';
import { resolveEnvironmentApiBaseUrl } from '@setup/envs/env-file-setup.util.js';
import { exportEnvFiles } from '@setup/envs/export-env-files.js';
import { upsertEnvFileValue } from '@setup/envs/read-env-file.js';

const POSTMAN_API_BASE = 'https://api.getpostman.com';
const API_KEYS_URL = 'https://go.postman.co/settings/me/api-keys';
// Lazy: resolved after config sets target.path, not at module import.
const collectionPath = (): string => resolve(targetRoot(), 'docs', 'postman-collection.json');

function errorMessage(error: unknown): string {
  // execSync (docs:all) throws with the real CLI output on `.stdout` / `.stderr` — include it so a
  // subprocess failure isn't reduced to an opaque "Command failed: …".
  const details = error as { message?: string; stdout?: unknown; stderr?: unknown };
  const output = [details?.stdout, details?.stderr]
    .map((part) => (part == null ? '' : String(part).trim()))
    .filter(Boolean)
    .join('\n')
    .trim();
  const base = error instanceof Error ? error.message : String(error);
  return output ? `${base}\n${output}` : base;
}

/** Call the Postman API (X-Api-Key auth) and parse JSON; throws with the body on non-2xx. */
async function postmanApi<T>(
  apiKey: string,
  path: string,
  init?: { method?: string; body?: string },
): Promise<T> {
  const method = init?.method ?? 'GET';
  const response = await setupFetch({
    name: 'Postman',
    url: `${POSTMAN_API_BASE}${path}`,
    init: {
      method,
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      ...(init?.body ? { body: init.body } : {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Postman API ${method} ${path} failed (${response.status}): ${body}`);
  }
  return (await response.json()) as T;
}

/** Adopt the workspace named after the project (by id or name), else create a personal one. */
async function findOrCreateWorkspace(
  apiKey: string,
  name: string,
  knownId: string | undefined,
): Promise<{ id: string; created: boolean }> {
  const list = await postmanApi<{ workspaces: Array<{ id: string; name: string }> }>(
    apiKey,
    '/workspaces',
  );
  const existing = list.workspaces.find(
    (workspace) => (knownId && workspace.id === knownId) || workspace.name === name,
  );
  if (existing) return { id: existing.id, created: false };
  const created = await postmanApi<{ workspace: { id: string } }>(apiKey, '/workspaces', {
    method: 'POST',
    body: JSON.stringify({ workspace: { name, type: 'personal' } }),
  });
  return { id: created.workspace.id, created: true };
}

function toProcessEnvironment(
  variables: ReturnType<typeof buildEnvironmentVariables>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === 'string' && value.length > 0) {
      environment[key] = value;
    }
  }
  return environment;
}

/** Upload ONE environment's collection (`<project>-<env>`, base URL baked in) into the workspace. */
export async function provision(
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
  environmentName: string,
): Promise<ProviderResult> {
  const apiKey = secrets.postman.apiKey;
  if (!apiKey) {
    return {
      success: true,
      message: 'Postman: skipped (POSTMAN_API_KEY missing in .setup-credentials)',
    };
  }

  // 1) Find or create the ONE workspace (named after the project) — idempotent across envs.
  const workspaceName = config.project.name;
  let workspaceId: string;
  try {
    const workspace = await findOrCreateWorkspace(
      apiKey,
      workspaceName,
      state.postman?.workspaceId,
    );
    workspaceId = workspace.id;
    logger.success(
      `  Postman workspace "${workspaceName}" — ${workspace.created ? 'created' : 'adopted'} (${workspaceId})`,
    );
  } catch (error) {
    return { success: false, message: `Postman: workspace setup failed — ${errorMessage(error)}` };
  }
  // Record the resolved workspace id back into each env file (it is an output, not an input).
  for (const environment of config.environments) {
    upsertEnvFileValue(environment.name, 'POSTMAN_WORKSPACE_ID', workspaceId);
  }

  // 2) Generate the OpenAPI spec + Postman collection for THIS environment (base URL baked in).
  exportEnvFiles();
  const subprocessEnv = toProcessEnvironment(
    buildEnvironmentVariables(environmentName, config, secrets, state),
  );
  const baseUrl = resolveEnvironmentApiBaseUrl(config, state, environmentName);
  if (baseUrl) {
    subprocessEnv.OPENAPI_SERVER_URL = baseUrl;
    subprocessEnv.OPENAPI_SERVER_DESCRIPTION = environmentName;
  }
  const spinner = logger.startSpinner(`Generating Postman collection for "${environmentName}"...`);
  try {
    execSync('pnpm docs:all', {
      cwd: targetRoot(),
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 60000,
      env: subprocessEnv,
    });
    logger.stopSpinner(spinner, `Postman collection generated for "${environmentName}"`);
  } catch (error) {
    logger.stopSpinner(spinner, 'Postman collection generation failed', 'fail');
    return { success: false, message: `Postman: ${errorMessage(error)}` };
  }

  if (!existsSync(collectionPath())) {
    logger.warn('Postman collection file not found — skipping upload');
    return {
      success: true,
      message: 'Postman: workspace ready but collection file not found for upload',
      stateUpdates: { postman: { ...state.postman, workspaceId } },
    };
  }

  // 3) Create (POST into the workspace) or update (PUT by uid) THIS env's collection.
  try {
    const collectionData = JSON.parse(readFileSync(collectionPath(), 'utf-8')) as {
      info?: { name?: string };
      [key: string]: unknown;
    };
    const collectionName = `${workspaceName}-${environmentName}`;
    if (collectionData.info) collectionData.info.name = collectionName;

    const knownCollectionId = state.postman?.collections?.[environmentName];
    const { method, path } = knownCollectionId
      ? { method: 'PUT', path: `/collections/${knownCollectionId}` }
      : { method: 'POST', path: `/collections?workspace=${workspaceId}` };

    const uploadSpinner = logger.startSpinner(`Uploading "${collectionName}" to Postman...`);
    const result = await postmanApi<{ collection?: { uid?: string } }>(apiKey, path, {
      method,
      body: JSON.stringify({ collection: collectionData }),
    });
    const collectionId = result.collection?.uid ?? knownCollectionId;
    logger.stopSpinner(
      uploadSpinner,
      `Postman collection "${collectionName}" uploaded${collectionId ? `: ${collectionId}` : ''}`,
    );

    return {
      success: true,
      message: `Postman: "${collectionName}" provisioned (${environmentName})`,
      stateUpdates: {
        postman: {
          ...state.postman,
          workspaceId,
          collections: {
            ...state.postman?.collections,
            ...(collectionId ? { [environmentName]: collectionId } : {}),
          },
        },
      },
    };
  } catch (error) {
    return { success: false, message: `Postman: ${errorMessage(error)}` };
  }
}

export const setupPostmanProvider: InfraProvider = {
  key: 'postman',
  name: 'Postman',
  isEnabled: ({ config, secrets }) =>
    config.providers.postman.enabled && Boolean(secrets.postman.apiKey),
  disabledReason: ({ config }) =>
    !config.providers.postman.enabled
      ? 'disabled in setup.config.json'
      : 'POSTMAN_API_KEY missing in .setup-credentials',
  preview: ({ config }) =>
    config.providers.postman.enabled
      ? {
          detail: 'Creates the workspace + uploads the collection (one API key)',
          url: API_KEYS_URL,
          configKey: '.setup-credentials → POSTMAN_API_KEY',
        }
      : null,
  settingsReview: ({ config }) =>
    config.providers.postman.enabled
      ? [{ bucket: 'resource', provider: 'Postman', detail: 'workspace + collection' }]
      : [],
  describe: ({ config, environments }) => ({ project: config.project.name, environments }),
  inspectRemote: async ({ config, secrets }) => {
    if (!config.providers.postman.enabled) {
      return { present: false, fields: [], error: 'disabled in setup.config.json' };
    }
    const apiKey = secrets.postman.apiKey;
    if (!apiKey) {
      return {
        present: false,
        fields: [],
        error: 'POSTMAN_API_KEY missing in .setup-credentials',
      };
    }
    try {
      const list = await postmanApi<{ workspaces: Array<{ id: string; name: string }> }>(
        apiKey,
        '/workspaces',
      );
      const expected = config.project.name;
      const workspace = list.workspaces.find((entry) => entry.name === expected);
      return {
        present: Boolean(workspace),
        fields: [
          {
            label: 'workspace',
            expected,
            remote: workspace?.name ?? (list.workspaces.length ? '(other workspaces exist)' : '—'),
            matches: Boolean(workspace),
          },
        ],
      };
    } catch (error) {
      return { present: false, fields: [], error: errorMessage(error) };
    }
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'Postman',
    enabled: setupPostmanProvider.isEnabled(context),
    enabledReason: setupPostmanProvider.disabledReason(context),
    instructions: [
      `Create a Postman API key: ${API_KEYS_URL} (any plan — a personal key is fine).`,
      'Add it to .setup-credentials as POSTMAN_API_KEY (account-wide setup credential).',
      `Setup CREATES one workspace named "${context.config.project.name}" (if absent) and, inside it,`,
      `a collection PER ENVIRONMENT ("${context.config.project.name}-<env>") with that env's API base URL baked in.`,
      'No workspace ID needed. Idempotent: the workspace and each per-env collection are reused/updated.',
    ],
    detectStatus: () => {
      const allUploaded = context.environments.every((environmentName) =>
        Boolean(context.state.postman?.collections?.[environmentName]),
      );
      return resourceStatus(allUploaded, 'Postman collection uploaded (per environment)');
    },
    execute: async () => {
      // One collection per environment (`<project>-<env>`) in the single workspace.
      for (const environmentName of context.environments) {
        const result = await provision(
          context.config,
          context.secrets,
          context.state,
          environmentName,
        );
        context.applyStateUpdates(result.stateUpdates ?? {});
        if (!result.success) throw new Error(result.message);
      }
      return {
        success: true,
        message: `Postman: collections uploaded for ${context.environments.join(', ')}`,
      };
    },
  }),
  deleteInstructions: ({ state }) => {
    if (!(state.postman?.collectionId || state.postman?.workspaceId)) return [];
    const resources: Array<{ label: string; identifier: string }> = [];
    if (state.postman.workspaceId)
      resources.push({ label: 'Workspace ID', identifier: state.postman.workspaceId });
    if (state.postman.collectionId)
      resources.push({ label: 'Collection UID', identifier: state.postman.collectionId });
    return [
      {
        provider: 'Postman',
        dashboardUrl: 'https://go.postman.co/workspaces',
        steps: [
          'Open the workspace, then delete the collection (⋯ → Delete) and/or the workspace.',
          'Workspaces: ⋯ next to the workspace name → Delete workspace.',
        ],
        resources,
      },
    ];
  },
};
