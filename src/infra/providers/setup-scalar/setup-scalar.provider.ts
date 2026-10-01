/**
 * Scalar Registry provider for `pnpm setup:infra`.
 *
 * One input only — SCALAR_API_KEY (an account-wide setup credential in `.setup-credentials`,
 * read via `secrets.scalar.apiKey`), mirroring the Postman provider. The script generates + publishes
 * a Scalar Registry doc PER ENVIRONMENT (`pnpm docs:generate` + `pnpm docs:upload:scalar`) under
 * slug `<base>-<env>` (base = `SCALAR_SLUG` override or the project name), each with that env's API
 * base URL baked into the OpenAPI `servers`. The team namespace is auto-resolved from the token.
 * Optional `SCALAR_NAMESPACE` / `SCALAR_SLUG` pins live in `.setup-credentials` for multi-team
 * accounts or a custom base slug. The publish logic lives in one place
 * (src/scripts/codegen/upload-scalar-registry.ts).
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*` (registry slug defaults to `config.project.name`), environment names
 * from `config.environments[].name` — never hardcoded.
 * SECRETS: SCALAR_API_KEY lives in `.setup-credentials` (gitignored, unreadable by the agent via
 * the deny-read guard) and is never printed to the console. See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import { execSync } from 'node:child_process';
import { targetRoot } from '@setup/common/paths.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as logger from '@setup/common/logger.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import { resolveEnvironmentApiBaseUrl } from '@setup/envs/env-file-setup.util.js';
import { buildEnvironmentVariables } from '@setup/envs/build-env-vars.js';
import { exportEnvFiles } from '@setup/envs/export-env-files.js';
import type {
  SetupConfig,
  SetupSecrets,
  SetupState,
  ProviderResult,
  InfraProvider,
  InfraProviderContext,
} from '@setup/common/types.js';

// import.meta.dirname is tooling/setup/infra/providers/setup-scalar — five levels
// below the repository root.
// Lazy: resolved after config sets target.path, not at module import.
const openapiSpecPath = (): string => resolve(targetRoot(), 'docs', 'openapi', 'openapi.json');
const SCALAR_REGISTRY_BASE_URL = 'https://registry.scalar.com';
// NAMING (single source of truth = setup.config.json): the Scalar registry slug
// defaults to the PROJECT NAME (`config.project.name`) — never hardcode it here.
// SCALAR_SLUG in .setup/.setup-credentials is only an explicit override.

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

function buildRegistryUrl(namespace: string, slug: string): string {
  return `${SCALAR_REGISTRY_BASE_URL}/@${namespace}/apis/${slug}/latest`;
}

/**
 * Surface the REAL subprocess failure. `execSync` with `stdio: 'pipe'` throws an error whose
 * `.message` is only "Command failed: …" — the actual CLI output is on `.stdout` / `.stderr`.
 * Include them so a Scalar/CLI error (plan limit, auth, invalid slug) is visible, not swallowed.
 */
function subprocessErrorDetail(error: unknown): string {
  const details = error as { message?: string; stdout?: unknown; stderr?: unknown };
  const output = [details?.stdout, details?.stderr]
    .map((part) => (part == null ? '' : String(part).trim()))
    .filter(Boolean)
    .join('\n')
    .trim();
  const base = details?.message ?? String(error);
  return output ? `${base}\n${output}` : base;
}

/**
 * Detect a Scalar plan / quota limit in the CLI output. Scalar's free plan caps how many registry
 * APIs (slugs) an account may publish, so a second per-environment slug fails once the cap is hit.
 * Treat that as a clear "not enough plan" message rather than an opaque command failure.
 */
function isPlanLimitError(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    /\bupgrade\b/.test(text) ||
    /maximum number of/.test(text) ||
    /not allowed on your( current)? plan/.test(text) ||
    /payment required/.test(text) ||
    /\b402\b/.test(text) ||
    /(plan|quota|subscription).*(limit|exceed|reach|allow)/.test(text) ||
    /(limit|exceed|reach).*(plan|quota|subscription)/.test(text)
  );
}

/** Publish ONE environment's OpenAPI doc to the Scalar Registry under a per-env slug. */
export async function provision(
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
  environmentName: string,
): Promise<ProviderResult> {
  const apiKey = secrets.scalar.apiKey;
  if (!apiKey) {
    return {
      success: true,
      message: 'Scalar: skipped (SCALAR_API_KEY missing in .setup-credentials)',
    };
  }

  // Namespace is optional — the Scalar CLI auto-resolves the active team's namespace from the
  // token when omitted. Slug is per-environment: `<base>-<env>` (base defaults to the project name).
  const namespaceOverride = secrets.scalar.namespace;
  const baseSlug = secrets.scalar.slug || config.project.name;
  const slug = `${baseSlug}-${environmentName}`;

  // Sync .env.<environment> from current state (preserving non-provisioned keys) so the
  // subprocess' dotenv loader doesn't override the injected env with stale empty values.
  exportEnvFiles();

  const environment = toProcessEnvironment(
    buildEnvironmentVariables(environmentName, config, secrets, state),
  );
  // SCALAR_* are setup credentials (not .env outputs) — inject them into the subprocess env.
  environment.SCALAR_API_KEY = apiKey;
  environment.SCALAR_SLUG = slug;
  // Own SCALAR_NAMESPACE explicitly. The publish subprocess loads `.env.<environment>` via its
  // dotenv loader (override:false), so any key we set here wins and any key we leave unset is
  // filled from the file. Without an explicit override we pin it EMPTY so a stale
  // `SCALAR_NAMESPACE` in `.env.<environment>` can't force a namespace that isn't assigned to the
  // team — the CLI then auto-resolves the token's active team namespace (why development works).
  environment.SCALAR_NAMESPACE = namespaceOverride ?? '';
  // Bake this environment's API base URL into the generated doc's `servers`, when known.
  const baseUrl = resolveEnvironmentApiBaseUrl(config, state, environmentName);
  if (baseUrl) {
    environment.OPENAPI_SERVER_URL = baseUrl;
    environment.OPENAPI_SERVER_DESCRIPTION = environmentName;
  }

  const spinner = logger.startSpinner(`Generating OpenAPI spec for "${environmentName}"...`);

  try {
    execSync('pnpm docs:generate', {
      cwd: targetRoot(),
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 60000,
      env: environment,
    });

    logger.stopSpinner(spinner, `OpenAPI spec generated for "${environmentName}"`);

    if (!existsSync(openapiSpecPath())) {
      logger.warn('OpenAPI spec not found — skipping Scalar Registry publish');
      return {
        success: true,
        message: 'Scalar: spec generated but file not found for upload',
      };
    }

    const uploadSpinner = logger.startSpinner(
      `Publishing "${slug}" to Scalar Registry (${environmentName})...`,
    );

    const output = execSync('pnpm docs:upload:scalar', {
      cwd: targetRoot(),
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 60000,
      env: environment,
    });

    // Resolve the namespace for the registry URL: the explicit override if set, else parse it
    // from the published URL the CLI prints (the active team's namespace it auto-resolved).
    const publishedMatch = output.match(/registry\.scalar\.com\/@([a-z0-9][a-z0-9-]*)\//i);
    const namespace = namespaceOverride || publishedMatch?.[1] || state.scalar?.namespace;
    const registryUrl = namespace ? buildRegistryUrl(namespace, slug) : undefined;

    logger.stopSpinner(
      uploadSpinner,
      registryUrl
        ? `Scalar published (${environmentName}): ${registryUrl}`
        : `Scalar published (${environmentName})`,
    );

    return {
      success: true,
      message: `Scalar: "${slug}" published (${environmentName})`,
      stateUpdates: {
        scalar: {
          ...state.scalar,
          ...(namespace ? { namespace } : {}),
          slug,
          ...(registryUrl ? { registryUrl } : {}),
          environments: {
            ...state.scalar?.environments,
            [environmentName]: { slug, ...(registryUrl ? { registryUrl } : {}) },
          },
        },
      },
    };
  } catch (provisionError) {
    const detail = subprocessErrorDetail(provisionError);
    if (isPlanLimitError(detail)) {
      const message =
        `Scalar: your current plan can't publish "${slug}" (${environmentName}) — ` +
        'the Scalar registry API limit was reached. Upgrade your Scalar plan to publish more ' +
        'environments, or disable Scalar in setup.config.json to skip it.';
      logger.warn(message);
      return { success: false, message };
    }
    logger.error(`Scalar provisioning failed (${environmentName}): ${detail}`);
    return { success: false, message: detail };
  }
}

export const setupScalarProvider: InfraProvider = {
  key: 'scalar',
  name: 'Scalar',
  isEnabled: ({ config, secrets }) =>
    config.providers.scalar.enabled && Boolean(secrets.scalar.apiKey),
  disabledReason: ({ config }) =>
    !config.providers.scalar.enabled
      ? 'disabled in setup.config.json'
      : 'SCALAR_API_KEY missing in .setup-credentials',
  preview: ({ config }) =>
    config.providers.scalar.enabled
      ? {
          detail: 'Publishes the OpenAPI doc (one API key; namespace auto-resolved)',
          url: 'https://dashboard.scalar.com',
          configKey: '.setup-credentials → SCALAR_API_KEY',
        }
      : null,
  settingsReview: ({ config }) =>
    config.providers.scalar.enabled
      ? [{ bucket: 'extra', provider: 'Scalar', detail: 'publish OpenAPI to registry' }]
      : [],
  describe: ({ config, environments }) => ({ project: config.project.name, environments }),
  inspectRemote: async ({ config, secrets, state }) => {
    if (!config.providers.scalar.enabled) {
      return { present: false, fields: [], error: 'disabled in setup.config.json' };
    }
    if (!secrets.scalar.apiKey) {
      return { present: false, fields: [], error: 'SCALAR_API_KEY missing in .setup-credentials' };
    }
    // The namespace is auto-resolved at publish time; verify presence only when it is known
    // (an explicit override or recorded from a prior publish).
    const namespace = secrets.scalar.namespace || state.scalar?.namespace;
    if (!namespace) {
      return { present: false, fields: [], error: 'namespace resolved at publish time' };
    }
    const slug = secrets.scalar.slug || config.project.name;
    try {
      const response = await setupFetch({ name: 'Scalar', url: buildRegistryUrl(namespace, slug) });
      return {
        present: response.ok,
        fields: [
          { label: 'slug', expected: slug, remote: response.ok ? slug : '—', matches: response.ok },
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
    name: 'Scalar',
    enabled: setupScalarProvider.isEnabled(context),
    enabledReason: setupScalarProvider.disabledReason(context),
    instructions: [
      'Add SCALAR_API_KEY to .setup-credentials (account-wide setup credential).',
      'Setup generates + publishes a Scalar Registry doc PER ENVIRONMENT — slug "<project>-<env>"',
      "with that env's API base URL baked in. The team namespace is auto-resolved from the token.",
      'Idempotent: re-publishing overrides the existing version (scalar registry publish --force).',
    ],
    detectStatus: () => {
      const allPublished = context.environments.every((environmentName) =>
        Boolean(context.state.scalar?.environments?.[environmentName]?.registryUrl),
      );
      return resourceStatus(allPublished, 'Scalar Registry published (per environment)');
    },
    execute: async () => {
      // One published slug per environment (`<base>-<env>`), each with its own base URL.
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
        message: `Scalar: published for ${context.environments.join(', ')}`,
      };
    },
  }),
  deleteInstructions: ({ state }) => {
    if (!state.scalar?.registryUrl) return [];
    const namespace = state.scalar.namespace ?? '';
    const slug = state.scalar.slug ?? '';
    return [
      {
        provider: 'Scalar',
        dashboardUrl: 'https://dashboard.scalar.com',
        steps: [
          'Open the Scalar dashboard → Registry.',
          `Locate the API by namespace/slug and delete it (or run: pnpm exec scalar registry delete ${namespace} ${slug}).`,
        ],
        resources: [{ label: 'Registry URL', identifier: state.scalar.registryUrl }],
      },
    ];
  },
};
