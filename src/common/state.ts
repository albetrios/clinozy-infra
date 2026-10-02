import { z } from 'zod';

const neonBranchStateSchema = z.object({
  branchId: z.string(),
  endpointId: z.string(),
  databaseUrl: z.string(),
  databaseMigrationUrl: z.string().optional(),
  serviceRoleName: z.string().optional(),
  /**
   * Password for the SQL-managed runtime role (see `ensureRuntimeRoleViaSql` in
   * `setup-neon.provider.ts`). Persisted so re-runs reuse the same connection string
   * across env files, GitHub Environments, and Railway. Absent for state written
   * by the legacy REST-API role flow — its absence is the signal to re-run the
   * Neon step and create the new `<env>_app_login` role.
   */
  serviceRolePassword: z.string().optional(),
});

const redisDatabaseStateSchema = z.object({
  databaseId: z.union([z.string(), z.number()]),
  publicEndpoint: z.string(),
  redisUrl: z.string(),
});

const s3BucketStateSchema = z.object({
  name: z.string(),
  region: z.string(),
});

const iamUserStateSchema = z.object({
  username: z.string(),
  arn: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
});

const railwayCustomDomainStateSchema = z.object({
  domain: z.string(),
  customDomainId: z.string(),
  targetPort: z.number().int().positive().optional(),
  verified: z.boolean().optional(),
  certificateStatus: z.string().optional(),
  attachedAt: z.string(),
});

const railwayServiceStateSchema = z.object({
  serviceId: z.string(),
  environmentId: z.string().optional(),
  url: z.string().optional(),
  customDomain: railwayCustomDomainStateSchema.optional(),
});

const jwtSecretStateSchema = z.union([
  z.string(),
  z.object({
    jwtSecret: z.string(),
    jwtPrivateKey: z.string().optional(),
    jwtPublicKey: z.string().optional(),
    jwtSigningKid: z.string().optional(),
    secretsEncryptionKey: z.string().optional(),
  }),
]);

const railwayEnvironmentStateSchema = z.object({
  environmentId: z.string(),
  services: z.record(z.string(), railwayServiceStateSchema),
});

export const setupStateSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  neon: z
    .object({
      projectId: z.string(),
      branches: z.record(z.string(), neonBranchStateSchema),
    })
    .optional(),
  redis: z
    .object({
      subscriptionId: z.number(),
      databases: z.record(z.string(), redisDatabaseStateSchema),
    })
    .optional(),
  aws: z
    .object({
      buckets: z.record(z.string(), s3BucketStateSchema),
      iamUsers: z.record(z.string(), iamUserStateSchema),
    })
    .optional(),
  sentry: z
    .object({
      projectSlug: z.string(),
      dsn: z.string(),
      /** Separate frontend (clinozy-fe) Sentry project slug, when `config.frontend.name` is set. */
      frontendProjectSlug: z.string().optional(),
      /** Frontend project DSN — public, emitted as SENTRY_FRONTEND_DSN for the clinozy-fe bundle. */
      frontendDsn: z.string().optional(),
    })
    .optional(),
  posthog: z
    .object({
      /** Legacy single project key (`phc_…`) — read as a fallback for older state. */
      projectApiKey: z.string().optional(),
      /**
       * Per-environment project keys (`phc_…`) keyed by environment name — one shared FE+BE
       * project per env (`clinozy-<env>`). Public by design; emitted as POSTHOG_KEY per env.
       */
      projectApiKeys: z.record(z.string(), z.string()).optional(),
      /** Ingestion host emitted as POSTHOG_HOST (US or EU cloud). */
      host: z.string(),
    })
    .optional(),
  jwt: z.record(z.string(), jwtSecretStateSchema).optional(),
  railway: z
    .object({
      version: z.number().optional(),
      projectId: z.string(),
      services: z.record(z.string(), railwayServiceStateSchema),
      environments: z.record(z.string(), railwayEnvironmentStateSchema).optional(),
      /**
       * Per-environment Railway project token, minted by the Railway provider via
       * `projectTokenCreate` when `secrets.railway.apiToken` (RAILWAY_API_TOKEN) is set.
       * Persisted so re-runs reuse the same token, and so `exportEnvFiles` can write
       * `RAILWAY_TOKEN=<env-scoped value>` to each `.env.<env>`. Absent when only the
       * single-token fallback (`RAILWAY_TOKEN`) is configured — in that mode every env
       * gets the same token, which only works for the single environment that token is
       * scoped to.
       */
      environmentTokens: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  github: z
    .object({
      repository: z.string(),
      secrets: z.array(z.string()),
    })
    .optional(),
  /** The frontend's Netlify site — one site serves every environment (aliases + --prod). */
  netlify: z
    .object({
      siteId: z.string(),
      siteName: z.string(),
      url: z.string(),
    })
    .optional(),
  postman: z
    .object({
      workspaceId: z.string().optional(),
      /** Legacy single-collection id (pre per-environment collections). */
      collectionId: z.string().optional(),
      /** Per-environment collection ids keyed by environment name (`clinozy-be-<env>` collections). */
      collections: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  scalar: z
    .object({
      namespace: z.string().optional(),
      slug: z.string().optional(),
      version: z.string().optional(),
      registryUrl: z.string().optional(),
      /** Per-environment published slugs + registry URLs (`clinozy-be-<env>`), keyed by env name. */
      environments: z
        .record(z.string(), z.object({ slug: z.string(), registryUrl: z.string().optional() }))
        .optional(),
    })
    .optional(),
});

// State is EPHEMERAL: held in memory for the lifetime of a single setup process and never
// persisted to disk — there is no `.setup-state.json`. Within one `pnpm setup:infra` run the
// in-memory object carries provider outputs (resource ids, urls, write-once secrets) to the
// env-file writer; standalone commands hydrate it from live remote via the reconstruct path
// (each provider's `detectRemote`). The durable record of provisioned values is the
// `.env.<environment>` files plus the providers' own dashboards — not a local state file.

function buildEmptyState(): z.infer<typeof setupStateSchema> {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

let inMemoryState: z.infer<typeof setupStateSchema> = buildEmptyState();

export function createEmptyState(): z.infer<typeof setupStateSchema> {
  return buildEmptyState();
}

/** Returns the process-scoped in-memory state. Empty until a run or reconstruct populates it. */
export function loadState(): z.infer<typeof setupStateSchema> {
  return inMemoryState;
}

/** Replaces the in-memory state. No disk write — state is never persisted. */
export function saveState(state: z.infer<typeof setupStateSchema>): void {
  state.updatedAt = new Date().toISOString();
  inMemoryState = state;
}

/**
 * Advisory-lock no-op. The ephemeral model has no shared state file for concurrent runs to
 * clobber, so there is nothing to lock. Returns a no-op `release()` for call-site symmetry.
 */
export function acquireStateLock(): () => void {
  return () => {};
}

/** Always false — there is no persisted state file in the ephemeral model. */
export function stateFileExists(): boolean {
  return false;
}

/** Resets the in-memory state to empty. */
export function clearState(): void {
  inMemoryState = buildEmptyState();
}
