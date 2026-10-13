import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { setFrontendRoot, setTargetRoot, toolPath } from '@setup/common/paths.js';
import { z } from 'zod';
import { SetupError } from './setup-error.js';

const sampleRatesSchema = z.object({
  traces: z.number().min(0).max(1),
  profile: z.number().min(0).max(1),
});

// Environment name is used as a filesystem path segment (`.env.<name>`) and inside
// `gh api` paths, so it is constrained to a safe slug — no dots/slashes/shell metachars.
const environmentNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'must be a lowercase slug: [a-z][a-z0-9-]*');
// Git branch names — letters, digits, and the usual ref punctuation only.
const branchNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._/-]+$/, 'must contain only letters, digits, and . _ / -');

const environmentSchema = z.object({
  name: environmentNameSchema,
  label: z.string().min(1),
  nodeEnvironment: z.enum(['development', 'production']),
  // `deployBranch` is the git branch whose pushes deploy to this environment.
  // It is NOT a Neon branch — Neon derives its project and branch from the
  // environment `name` (see neonEnvironmentNames), and a `protected`
  // environment gets a protected Neon branch. `protected` mirrors the GitHub
  // branch-protection status used by deploy gates (`development` and
  // `production` are protected by default; ephemeral / preview environments
  // may set `protected: false`).
  deployBranch: branchNameSchema,
  protected: z.boolean(),
  isDefault: z.boolean().optional(),
});

const perEnvironmentString = z.record(z.string(), z.string());
const perEnvironmentNumber = z.record(z.string(), z.number());

const projectArtifactsSchema = z.object({
  apiImage: z.string().min(1),
  workerImage: z.string().min(1),
  dockerLocalApiTag: z.string().min(1),
  ghcrCacheScopeApi: z.string().min(1),
  ghcrCacheScopeWorker: z.string().min(1),
});

const projectGitSchema = z.object({
  protectedBranches: z.array(branchNameSchema).min(1).optional(),
  defaultBranch: branchNameSchema.optional(),
});

export const setupConfigSchema = z.object({
  // ─── NAMING — SINGLE SOURCE OF TRUTH ────────────────────────────────────────
  // setup.config.json is the ONE place these names are defined. Every setup script
  // and provider MUST read them from the loaded config — never hardcode a literal:
  //   • project.name         — PROJECT NAME (e.g. slugs, image tags, Scalar slug)
  //   • project.displayName   — human-readable PROJECT NAME (logs, email "from name")
  //   • project.organization  — ORGANIZATION NAME (Sentry org, GitHub owner, etc.)
  //   • environments[].name   — ENVIRONMENT NAMES (the only valid env identifiers;
  //                             alias maps like dev→development only NORMALIZE input)
  // Change a name here and re-run `pnpm setup:infra:init`.
  project: z.object({
    name: z.string().min(1),
    displayName: z.string().min(1),
    organization: z.string().min(1),
    artifacts: projectArtifactsSchema.optional(),
    // Every name this repo has carried — written by `pnpm rebrand`, guarded by
    // `pnpm validate:identity`. Declared so a saveConfig round-trip keeps it.
    previousNames: z.array(z.string().min(1)).optional(),
  }),
  git: projectGitSchema.optional(),
  /**
   * Product-level name for resources SHARED by the backend and frontend (PostHog project,
   * Turnstile widget) — named `<product.name>-<env>` (e.g. `clinozy-development`). Optional;
   * defaults to `project.name` so existing configs keep backend-centric naming.
   */
  product: z
    .object({
      name: z.string().min(1),
      // The product's own domain (e.g. `clinozy.com`) — the single source for every public address:
      // app.<domain> / api.<domain> in production, <env>--api.<domain> elsewhere, noreply@<domain>.
      domain: z
        .string()
        .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'must be a bare domain like example.com')
        .optional(),
    })
    .optional(),
  /**
   * Frontend (clinozy-fe) identity. `name` is the frontend's Sentry project (separate from the
   * backend project); `url` is the per-environment frontend origin (used for the Turnstile widget
   * domain list); `path` locates the independent clinozy-fe repo for writing its `.env.<env>`
   * (resolution: `CLINOZY_FE_DIR` → this → default sibling `../clinozy-fe`). Optional — omit when there is
   * no separate frontend.
   */
  frontend: z
    .object({
      name: z.string().min(1),
      url: perEnvironmentString.optional(),
      path: z.string().min(1).optional(),
    })
    .optional(),
  /**
   * Location of the backend target repo (clinozy-be), relative to this tool root. Resolution:
   * `CLINOZY_BE_DIR` env → this `target.path` → default sibling `../clinozy-be`. Optional.
   */
  target: z.object({ path: z.string().min(1).optional() }).optional(),
  environments: z.array(environmentSchema).min(1),
  providers: z.object({
    neon: z.object({
      enabled: z.boolean(),
      region: z.string().min(1),
      pgVersion: z.number().int().min(17).max(17).default(17),
      computeSize: z.object({
        min: z.number().min(0.25),
        max: z.number().min(0.25),
      }),
      // Point-in-time restore window per environment name, in days. Neon caps it by plan
      // (Free 0.25, Launch 7, Scale 30); an environment left out keeps Neon's default (1 day).
      historyRetentionDays: z.record(z.string(), z.number().int().min(0).max(30)).optional(),
    }),
    railwayRedis: z.object({
      enabled: z.boolean(),
      // Image, start command, password, and volume are managed by Railway's
      // `redis` database template (deployed via `templateDeployV2`). The
      // fields below are post-deploy overrides applied with
      // `serviceInstanceUpdate`; leave them unset to inherit Railway defaults.
      region: z.string().min(1).optional(),
      cpuLimit: z.number().positive().optional(),
      memoryLimitMb: z.number().int().positive().optional(),
    }),
    aws: z.object({
      enabled: z.boolean(),
      region: z.string().min(1),
      s3BucketPrefix: z.string().min(1),
      iamUserPrefix: z.string().min(1),
    }),
    sentry: z
      .object({
        enabled: z.boolean(),
        organization: z.string().min(1),
        project: z.string().min(1).optional(),
        team: z.string().min(1).optional(),
        platform: z.string().default('node'),
        sampleRates: z.record(z.string(), sampleRatesSchema),
      })
      .refine((s) => (s.project ?? s.team) != null, {
        message: 'sentry.project or sentry.team required',
      }),
    resend: z.object({
      enabled: z.boolean(),
      // Empty => derived at emit time so a project rename auto-updates them:
      //   fromAddress -> noreply@<project.name>.com   (see resolveResendFromAddress)
      //   fromName    -> <project.displayName>          (see resolveResendFromName)
      // Set a non-empty value here to pin an explicit override (e.g. a verified domain).
      fromAddress: z.string().default(''),
      fromName: z.string().default(''),
    }),
    stripe: z.object({
      enabled: z.boolean(),
    }),
    oauth: z.object({
      google: z.object({ enabled: z.boolean() }),
      github: z.object({ enabled: z.boolean() }),
    }),
    posthog: z.object({
      enabled: z.boolean(),
      region: z.enum(['us', 'eu']).default('us'),
    }),
    turnstile: z.object({ enabled: z.boolean() }),
    railway: z.object({ enabled: z.boolean() }),
    github: z.object({
      enabled: z.boolean(),
      // `owner/repo` — restricted to GitHub's allowed identifier characters so the value can't
      // smuggle shell metacharacters or extra path segments into `gh api repos/<repository>/…`.
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      /**
       * Push local `.env.<environment>` secrets/variables to GitHub Environments as the final
       * setup:infra step ("Sync .env.<environment> to GitHub Environments"). Set to false to skip
       * that sync entirely (e.g. when GitHub Environment config is managed elsewhere, or to avoid
       * GitHub's secondary rate limit). Branch/ruleset/environment creation is unaffected. Default true.
       */
      syncEnvironments: z.boolean().default(true),
    }),
    postman: z.object({ enabled: z.boolean() }),
    scalar: z.object({ enabled: z.boolean() }),
    // The frontend's Netlify site — found (or created) from `frontend.url.production`. Optional so
    // configs that predate it keep loading; absent means disabled.
    netlify: z.object({ enabled: z.boolean() }).optional(),
  }),
  app: z.object({
    port: z.number().int().default(3000),
    host: z.string().default('0.0.0.0'),
    rateLimitMax: perEnvironmentNumber,
    rateLimitWindowMs: z.number().int().default(60000),
    // Legacy name: the public API (backend) origin per env — Postman/Scalar servers, webhook and
    // Turnstile hosts. NOT the SPA: the backend's FRONTEND_URL comes from `frontend.url`.
    frontendUrl: perEnvironmentString,
    // CORS allowlist (comma-separated) — the SPA origin(s) that call the API.
    allowedOrigins: perEnvironmentString,
  }),
});

const CONFIG_PATH = toolPath('setup.config.json');

type ParsedSetupConfig = z.infer<typeof setupConfigSchema>;

function buildDefaultArtifacts(
  projectSlug: string,
): NonNullable<ParsedSetupConfig['project']['artifacts']> {
  return {
    apiImage: `${projectSlug}-api`,
    workerImage: `${projectSlug}-worker`,
    dockerLocalApiTag: projectSlug,
    ghcrCacheScopeApi: `${projectSlug}-api`,
    ghcrCacheScopeWorker: `${projectSlug}-worker`,
  };
}

function normalizeLoadedConfig(config: ParsedSetupConfig): ParsedSetupConfig {
  const artifacts = config.project.artifacts ?? buildDefaultArtifacts(config.project.name);
  const protectedBranches =
    config.git?.protectedBranches ??
    config.environments.map((environment) => environment.deployBranch);
  const defaultBranch =
    config.git?.defaultBranch ??
    config.environments.find((environment) => environment.isDefault)?.deployBranch ??
    config.environments[0]?.deployBranch ??
    'main';

  return {
    ...config,
    project: { ...config.project, artifacts },
    git: { protectedBranches, defaultBranch },
  };
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Parse + validate + normalize the config text, and point the target/frontend roots at the
 * repos it declares. Throws `SetupError` (with a specific hint) on invalid JSON or schema
 * failure — callers that want best-effort behavior catch it.
 */
function parseAndNormalizeConfig(raw: string): z.infer<typeof setupConfigSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SetupError(`Config file is not valid JSON: ${CONFIG_PATH}`, {
      hint: error instanceof Error ? error.message : String(error),
    });
  }

  const result = setupConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new SetupError(`Config file is invalid: ${CONFIG_PATH}`, {
      hint: z.prettifyError(result.error),
    });
  }

  const config = result.data;

  // Normalize Sentry config: prefer explicit project, but when only team is set,
  // treat the project as the clinozy-be project name so previews show organization/project.
  if (
    config.providers.sentry.enabled &&
    !config.providers.sentry.project &&
    config.providers.sentry.team
  ) {
    config.providers.sentry.project = config.project.name;
  }

  const normalized = normalizeLoadedConfig(config);
  // Point each target root at the repo the config declares. `CLINOZY_BE_DIR`/`CLINOZY_FE_DIR`
  // env vars still win; the default siblings ../clinozy-be and ../clinozy-fe apply otherwise.
  setTargetRoot(normalized.target?.path);
  setFrontendRoot(normalized.frontend?.path);
  return normalized;
}

/** Load config if the file exists and is valid. Returns null when missing OR invalid (for init defaults). */
export function loadConfigIfExists(): z.infer<typeof setupConfigSchema> | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return parseAndNormalizeConfig(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function loadConfig(): z.infer<typeof setupConfigSchema> {
  if (!existsSync(CONFIG_PATH)) {
    throw new SetupError(`Config file not found: ${CONFIG_PATH}`, {
      hint: 'Run pnpm setup --init to create tooling/setup/setup.config.json.',
    });
  }
  // Surfaces the specific JSON/schema error instead of a generic "not found or invalid".
  return parseAndNormalizeConfig(readFileSync(CONFIG_PATH, 'utf-8'));
}

/** The frontend's GitHub repository: the backend repository's owner + `frontend.name`. */
export function frontendRepository(config: ParsedSetupConfig): string | undefined {
  const owner = config.providers.github.repository.split('/')[0];
  return owner && config.frontend?.name ? `${owner}/${config.frontend.name}` : undefined;
}

export function getEnvironmentNames(config: z.infer<typeof setupConfigSchema>): string[] {
  return config.environments.map((environment) => environment.name);
}

/**
 * Persists the config back to `tooling/setup/setup.config.json`. This file
 * doubles as the saved "answers" for project / organization / branches /
 * environments — when the user runs `pnpm setup:infra` again they see the
 * previously chosen values as defaults and don't have to re-enter them.
 */
export function saveConfig(config: z.infer<typeof setupConfigSchema>): void {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}
