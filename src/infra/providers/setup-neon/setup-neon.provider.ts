/**
 * Neon Postgres provider for `pnpm setup:infra`.
 *
 * Provisions the Neon project + per-environment branches and runtime roles; records
 * connection URLs to state.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only (via build-env-vars), never printed to the
 * console; setup secret files are gitignored and unreadable by the agent (deny-read guard). See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import * as logger from '@setup/common/logger.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import { isSecretFilled } from '@setup/common/secrets.js';
import type {
  SetupConfig,
  SetupSecrets,
  SetupState,
  ProviderResult,
  InfraProvider,
  InfraProviderContext,
} from '@setup/common/types.js';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

/**
 * Collapse Postgres NOTICE messages (e.g. "role already granted membership") to a single readable
 * line — the `postgres` client's default handler dumps the raw multi-field object to the console.
 */
function logNeonNotice(notice: { message?: string }): void {
  if (notice.message) logger.info(`pg notice: ${notice.message}`);
}

/** Postgres schemas owned by clinozy-be migrations. Kept in sync with src/infrastructure/database/pg-schemas.ts. */
const CLINOZY_BE_APP_SCHEMAS = [
  'auth',
  'tenancy',
  'billing',
  'notify',
  'audit',
  'upload',
  'public',
] as const;

const POSTGRES_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Resolve the Neon branch name for an environment — the environment name itself.
 *
 * Neon branches are named after environments (development → "development",
 * production → "production"), independent of the git `deployBranch`. The lookup
 * still validates that the environment exists in setup.config.json.
 */
function getNeonBranchName(config: SetupConfig, environmentName: string): string {
  const environment = config.environments.find((entry) => entry.name === environmentName);
  if (!environment) {
    throw new Error(`Unknown environment "${environmentName}" in setup.config.json`);
  }
  return environmentName;
}

/**
 * Build the per-environment runtime role name (e.g. development_app_login).
 *
 * Convention: `<environment>_app_login`. Replaces the older `<environment>_service_user`
 * convention; the old roles, when created via Neon's REST API, were assigned
 * `BYPASSRLS=true` by Neon and therefore silently collapsed tenant isolation. The new
 * roles are created via SQL `CREATE ROLE … LOGIN PASSWORD …` (see
 * `ensureRuntimeRoleViaSql`), which Neon does NOT taint with BYPASSRLS.
 */
function getServiceRoleName(environmentName: string): string {
  const candidate = `${environmentName}_app_login`;
  if (!POSTGRES_IDENTIFIER_PATTERN.test(candidate)) {
    throw new Error(
      `Cannot derive Postgres role from environment name "${environmentName}" — expected lowercase letters, digits, underscores.`,
    );
  }
  return candidate;
}

/** Legacy role name (Neon REST-API created, gets BYPASSRLS). Kept for cleanup messaging. */
function getLegacyServiceRoleName(environmentName: string): string {
  return `${environmentName}_service_user`;
}

/** Generate a 32-char base64url password. Charset is `[A-Za-z0-9_-]`, so no SQL escaping needed. */
function generateRolePassword(): string {
  return randomBytes(24).toString('base64url');
}

/** base64url is `[A-Za-z0-9_-]` only — safe to inline in a single-quoted SQL literal. */
const ROLE_PASSWORD_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertRolePasswordSafeForSql(password: string): void {
  if (!ROLE_PASSWORD_PATTERN.test(password)) {
    throw new Error(
      'Refusing to use a role password containing characters outside [A-Za-z0-9_-]; the SQL CREATE/ALTER ROLE path inlines the password and cannot escape arbitrary characters safely.',
    );
  }
}

/**
 * Derive the pooled hostname for a Neon endpoint from the direct (migration) connection URL.
 * Neon pooled endpoints follow the `<endpoint-id>-pooler.<region>.aws.neon.tech` convention;
 * the direct endpoint is `<endpoint-id>.<region>.aws.neon.tech`. Idempotent if the hostname
 * already contains `-pooler`.
 */
function derivePooledHostFromMigrationUrl(migrationUrl: string): string {
  const url = new URL(migrationUrl);
  const segments = url.hostname.split('.');
  const head = segments[0] ?? '';
  if (!head) {
    throw new Error(
      `Cannot derive pooled host from migration URL "${migrationUrl}" — empty hostname.`,
    );
  }
  if (head.endsWith('-pooler')) {
    return url.hostname;
  }
  segments[0] = `${head}-pooler`;
  return segments.join('.');
}

/** Build the pooled DATABASE_URL for a freshly-created SQL runtime role. */
function buildPooledDatabaseUrl({
  migrationUrl,
  roleName,
  rolePassword,
}: {
  migrationUrl: string;
  roleName: string;
  rolePassword: string;
}): string {
  const direct = new URL(migrationUrl);
  direct.hostname = derivePooledHostFromMigrationUrl(migrationUrl);
  direct.username = roleName;
  direct.password = rolePassword;
  // Preserve `channel_binding=require&sslmode=require` and `/neondb` path from the migration URL.
  return direct.toString();
}

function neonHeaders(apiKey: string, orgId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (orgId) {
    headers['Neon-Org-Id'] = orgId;
  }
  return headers;
}

async function neonRequest<T>(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  orgId?: string,
): Promise<T> {
  const resolvedOrgId = orgId ?? query?.org_id;
  const url = new URL(`${NEON_API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  const response = await setupFetch({
    name: 'Neon',
    url: url.toString(),
    init: {
      method,
      headers: neonHeaders(apiKey, resolvedOrgId),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Neon API ${method} ${path} failed (${response.status}): ${errorBody}`);
  }

  return response.json() as Promise<T>;
}

interface NeonOrganization {
  id: string;
  name: string;
  created_at?: string;
}

interface NeonOrganizationsResponse {
  organizations: NeonOrganization[];
}

/** Resolve Neon org_id: fetch user's organizations and pick one (by name match or first). */
async function resolveNeonOrgId(
  apiKey: string,
  preferredOrganizationName?: string,
): Promise<string> {
  const response = await neonRequest<
    NeonOrganizationsResponse & { data?: { organizations?: NeonOrganization[] } }
  >(apiKey, 'GET', '/users/me/organizations');
  const organizations = response.data?.organizations ?? response.organizations ?? [];
  if (organizations.length === 0) {
    throw new Error(
      'No Neon organization found. Create one at https://console.neon.tech/app/settings or use an organization API key.',
    );
  }
  const match = preferredOrganizationName
    ? organizations.find(
        (org) =>
          org.name?.toLowerCase() === preferredOrganizationName.toLowerCase() ||
          org.id === preferredOrganizationName,
      )
    : undefined;
  const organization = match ?? organizations[0];
  if (!organization) {
    throw new Error(
      'No Neon organization found. Create one at https://console.neon.tech/app/settings or use an organization API key.',
    );
  }
  const orgId = organization.id;
  return orgId;
}

const NEON_ORG_ID_HELP =
  'Set NEON_ORG_ID in .setup/.setup-credentials (e.g. NEON_ORG_ID=org-xxx). Get it at https://console.neon.tech/app/settings → Organization → General.';

/**
 * Resolve Neon organization id from setup credentials or the org list API.
 * Required for org-scoped API keys on `GET /projects` and project creation.
 */
async function ensureNeonOrgId(
  apiKey: string,
  secrets: SetupSecrets,
  config: SetupConfig,
): Promise<string> {
  const fromSecrets =
    typeof secrets.neon.orgId === 'string' && secrets.neon.orgId.trim()
      ? secrets.neon.orgId.trim()
      : '';
  const orgId = fromSecrets || (await resolveNeonOrgId(apiKey, config.project.organization));
  if (!orgId) {
    throw new Error(`Neon org_id is required. ${NEON_ORG_ID_HELP}`);
  }
  return orgId;
}

interface NeonProject {
  project: {
    id: string;
    name: string;
  };
  connection_uris?: Array<{
    connection_uri: string;
  }>;
}

interface NeonBranch {
  branch: {
    id: string;
    name: string;
  };
  endpoints?: Array<{
    id: string;
    host: string;
  }>;
  connection_uris?: Array<{
    connection_uri: string;
  }>;
}

interface NeonConnectionUri {
  uri: string;
}

interface NeonProjectSummary {
  id: string;
  name: string;
}

interface NeonProjectsListResponse {
  projects: NeonProjectSummary[];
}

async function findExistingProjectId(
  apiKey: string,
  projectName: string,
  orgId: string,
): Promise<string | undefined> {
  const response = await neonRequest<NeonProjectsListResponse>(
    apiKey,
    'GET',
    '/projects',
    undefined,
    { org_id: orgId },
    orgId,
  );
  return response.projects.find((project) => project.name === projectName)?.id;
}

interface NeonBranchSummary {
  id: string;
  name: string;
  /** Neon marks exactly one branch per project as the default (auto-created with the project). */
  default?: boolean;
}

interface NeonBranchesListResponse {
  branches: NeonBranchSummary[];
}

async function listBranches(apiKey: string, projectId: string): Promise<NeonBranchSummary[]> {
  const response = await neonRequest<NeonBranchesListResponse>(
    apiKey,
    'GET',
    `/projects/${projectId}/branches`,
  );
  return response.branches ?? [];
}

interface NeonOperation {
  id: string;
  action: string;
  status: string;
}

interface NeonOperationsResponse {
  operations: NeonOperation[];
}

const NEON_OPERATION_TERMINAL_STATUSES = new Set([
  'finished',
  'failed',
  'error',
  'cancelled',
  'skipped',
]);
const NEON_OPERATION_POLL_INTERVAL_MS = 2000;
const NEON_OPERATION_POLL_TIMEOUT_MS = 120_000;

/**
 * Poll Neon's operations endpoint until all pending operations reach a terminal status.
 * Neon project / branch mutations are asynchronous; subsequent calls can return 423 if
 * the project still has operations in flight.
 */
async function waitForOperations(apiKey: string, projectId: string): Promise<void> {
  const deadline = Date.now() + NEON_OPERATION_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await neonRequest<NeonOperationsResponse>(
      apiKey,
      'GET',
      `/projects/${projectId}/operations`,
    );
    const pending = (response.operations ?? []).filter(
      (operation) => !NEON_OPERATION_TERMINAL_STATUSES.has(operation.status),
    );
    if (pending.length === 0) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, NEON_OPERATION_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Neon project "${projectId}" still has pending operations after ${Math.round(
      NEON_OPERATION_POLL_TIMEOUT_MS / 1000,
    )}s; aborting to avoid 423 conflicts.`,
  );
}

const NEON_OWNER_ROLE = 'neondb_owner';
const NEON_DEFAULT_DATABASE = 'neondb';

interface NeonBranchEntry {
  branchId: string;
  endpointId: string;
  databaseUrl: string;
  databaseMigrationUrl?: string;
  serviceRoleName?: string;
  /**
   * Password for the SQL-managed runtime role (see `ensureRuntimeRoleViaSql`).
   * Persisted so `pnpm setup:infra` is idempotent across runs; the same value
   * is inlined into `databaseUrl` and pushed to Railway / GitHub Environments.
   */
  serviceRolePassword?: string;
}

interface GetConnectionUriOptions {
  apiKey: string;
  projectId: string;
  branchId: string;
  roleName: string;
  pooled: boolean;
}

async function getConnectionUri(options: GetConnectionUriOptions): Promise<string> {
  const connectionResponse = await neonRequest<NeonConnectionUri>(
    options.apiKey,
    'GET',
    `/projects/${options.projectId}/connection_uri`,
    undefined,
    {
      branch_id: options.branchId,
      database_name: NEON_DEFAULT_DATABASE,
      role_name: options.roleName,
      pooled: String(options.pooled),
    },
  );
  return connectionResponse.uri;
}

interface EnsureRuntimeRoleViaSqlOptions {
  migrationUrl: string;
  roleName: string;
  rolePassword: string;
  environmentName: string;
}

interface EnsureRuntimeRoleViaSqlResult {
  /** True when the role didn't exist before this call. False if it already existed. */
  roleCreated: boolean;
  /** True when `GRANT clinozy_be_app TO <roleName>` was executed (skipped if `clinozy_be_app` is absent). */
  clinozyBeAppMembershipGranted: boolean;
}

/**
 * Create or update the per-environment runtime role using SQL connecting as `neondb_owner`.
 *
 * **Why not Neon's REST API?** Neon assigns `BYPASSRLS=true` to every role created via
 * `POST /projects/{id}/branches/{id}/roles` (and via the Neon console / CLI). Postgres skips
 * Row Level Security for roles with `BYPASSRLS`, which silently collapses tenant isolation
 * on every RLS-only read path. Neon does not expose superuser, so the attribute cannot be
 * cleared via `ALTER ROLE … NOBYPASSRLS` either (the call returns "permission denied").
 *
 * SQL `CREATE ROLE … LOGIN PASSWORD …` connecting as `neondb_owner` does NOT inherit this
 * attribute — the role gets the safe default of `rolbypassrls=false`. After creation, this
 * function grants `clinozy_be_app` membership (created by `migrations/00000000000000_init.sql`)
 * so the runtime role inherits the standard DML grants automatically.
 *
 * Idempotent: re-creates the role only if missing, otherwise rotates the password via
 * `ALTER ROLE`. Re-granting `clinozy_be_app` membership is a no-op when already a member.
 *
 * A post-create assertion fails closed if the role somehow ended up with `rolsuper=true`
 * or `rolbypassrls=true` — this mirrors `assertDatabaseRoleRlsSafety` in the runtime and
 * is the only thing standing between a quiet RLS bypass and a production tenant leak.
 */
async function ensureRuntimeRoleViaSql(
  options: EnsureRuntimeRoleViaSqlOptions,
): Promise<EnsureRuntimeRoleViaSqlResult> {
  const { migrationUrl, roleName, rolePassword, environmentName } = options;
  if (!POSTGRES_IDENTIFIER_PATTERN.test(roleName)) {
    throw new Error(`Refusing to manage unsafe role identifier: ${roleName}`);
  }
  assertRolePasswordSafeForSql(rolePassword);

  const sql = postgres(migrationUrl, { max: 1, prepare: false, onnotice: logNeonNotice });
  try {
    const existingRows = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname = ${roleName}
    `;
    const roleAlreadyExists = existingRows.length > 0;
    if (roleAlreadyExists) {
      await sql.unsafe(`ALTER ROLE ${roleName} WITH LOGIN PASSWORD '${rolePassword}'`);
    } else {
      await sql.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}'`);
    }

    const attributeRows = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${roleName}
    `;
    const attributes = attributeRows[0];
    if (!attributes) {
      throw new Error(
        `Runtime role "${roleName}" not visible in pg_roles after CREATE/ALTER on "${environmentName}".`,
      );
    }
    if (attributes.rolsuper || attributes.rolbypassrls) {
      throw new Error(
        `Runtime role "${roleName}" has rolsuper=${attributes.rolsuper} rolbypassrls=${attributes.rolbypassrls} on "${environmentName}" — incompatible with FORCE ROW LEVEL SECURITY. ` +
          'Confirm the role was created via SQL (not the Neon REST API / console / CLI, which all assign BYPASSRLS).',
      );
    }

    await sql.unsafe(`GRANT CONNECT ON DATABASE ${NEON_DEFAULT_DATABASE} TO ${roleName}`);

    const appRoleRows = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname = 'clinozy_be_app'
    `;
    let clinozyBeAppMembershipGranted = false;
    if (appRoleRows.length > 0) {
      await sql.unsafe(`GRANT clinozy_be_app TO ${roleName}`);
      clinozyBeAppMembershipGranted = true;
    } else {
      logger.warn(
        `  clinozy_be_app role not present on "${environmentName}" yet — run \`pnpm db:migrate\` and re-run \`pnpm setup:infra\` to grant runtime privileges via membership.`,
      );
    }

    return { roleCreated: !roleAlreadyExists, clinozyBeAppMembershipGranted };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface GrantRuntimePrivilegesOptions {
  migrationUrl: string;
  roleName: string;
  environmentName: string;
}

/**
 * Connect as `neondb_owner` and grant least-privilege DML access to the runtime
 * role across all clinozy-be application schemas. Tolerant of schemas that don't
 * exist yet (first-time setup before migrations have run) — we list pg_namespace
 * up-front and only grant on schemas that are present.
 */
async function grantRuntimePrivileges(options: GrantRuntimePrivilegesOptions): Promise<string[]> {
  const { migrationUrl, roleName, environmentName } = options;
  if (!POSTGRES_IDENTIFIER_PATTERN.test(roleName)) {
    throw new Error(`Refusing to grant on unsafe role identifier: ${roleName}`);
  }

  const sql = postgres(migrationUrl, { max: 1, prepare: false, onnotice: logNeonNotice });
  const grantedSchemas: string[] = [];
  try {
    const existing = await sql<{ nspname: string }[]>`
      SELECT nspname
      FROM pg_namespace
      WHERE nspname = ANY(${[...CLINOZY_BE_APP_SCHEMAS]}::text[])
    `;
    const existingSchemas = new Set(existing.map((row) => row.nspname));

    await sql.unsafe(`GRANT CONNECT ON DATABASE ${NEON_DEFAULT_DATABASE} TO ${roleName}`);

    for (const schema of CLINOZY_BE_APP_SCHEMAS) {
      if (!existingSchemas.has(schema)) continue;
      await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${roleName}`);
      await sql.unsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${roleName}`,
      );
      await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${roleName}`);
      await sql.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${NEON_OWNER_ROLE} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleName}`,
      );
      await sql.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${NEON_OWNER_ROLE} IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${roleName}`,
      );
      grantedSchemas.push(schema);
    }

    if (grantedSchemas.length === 0) {
      logger.warn(
        `  No clinozy-be schemas present yet on "${environmentName}" — run \`pnpm db:migrate\` and re-run \`pnpm setup:infra\` to grant runtime privileges.`,
      );
    }

    return grantedSchemas;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface EnsureBranchRuntimeRoleOptions {
  apiKey: string;
  projectId: string;
  environmentName: string;
  entry: NeonBranchEntry;
}

/**
 * Ensure the per-environment runtime role exists (created via SQL, not Neon REST), build
 * the pooled DATABASE_URL from the migration URL, and grant DML access — either by
 * `clinozy_be_app` membership (preferred) or by explicit schema grants (fallback when
 * migrations haven't run yet). Returns the updated branch entry with the role name and
 * password persisted to state.
 *
 * Idempotent: re-runs reuse the previously-generated password from state so existing
 * connection strings (Railway, GitHub Environments, local .env) keep working.
 */
async function ensureBranchRuntimeRole(
  options: EnsureBranchRuntimeRoleOptions,
): Promise<NeonBranchEntry> {
  const { apiKey, projectId, environmentName, entry } = options;
  const serviceRoleName = getServiceRoleName(environmentName);
  const legacyRoleName = getLegacyServiceRoleName(environmentName);

  const databaseMigrationUrl = await getConnectionUri({
    apiKey,
    projectId,
    branchId: entry.branchId,
    roleName: NEON_OWNER_ROLE,
    pooled: false,
  });

  // Reuse the password from state when the role and password are already recorded — that
  // keeps re-runs of `pnpm setup:infra` idempotent across env files, GitHub Environments,
  // and Railway. Generate a fresh password only when we have nothing to reuse.
  const rolePassword =
    entry.serviceRoleName === serviceRoleName && entry.serviceRolePassword
      ? entry.serviceRolePassword
      : generateRolePassword();

  const ensureResult = await ensureRuntimeRoleViaSql({
    migrationUrl: databaseMigrationUrl,
    roleName: serviceRoleName,
    rolePassword,
    environmentName,
  });
  logger.success(
    ensureResult.roleCreated
      ? `  Runtime role "${serviceRoleName}" created via SQL on Neon branch ${entry.branchId}`
      : `  Runtime role "${serviceRoleName}" already exists on Neon branch ${entry.branchId} (password refreshed)`,
  );
  if (ensureResult.clinozyBeAppMembershipGranted) {
    logger.success(`  Granted clinozy_be_app membership to "${serviceRoleName}" (inherits DML)`);
  }

  // Fall back to explicit schema grants when `clinozy_be_app` is not yet defined (e.g. first
  // run before migrations). Once migrations land, subsequent runs use the inherited grants.
  if (!ensureResult.clinozyBeAppMembershipGranted) {
    const grantedSchemas = await grantRuntimePrivileges({
      migrationUrl: databaseMigrationUrl,
      roleName: serviceRoleName,
      environmentName,
    });
    if (grantedSchemas.length > 0) {
      logger.success(
        `  Granted runtime privileges directly to "${serviceRoleName}" on schemas: ${grantedSchemas.join(', ')} (no clinozy_be_app yet)`,
      );
    }
  }

  // Surface (but do not auto-drop) the legacy `<env>_service_user` role left by previous
  // versions of this provider — it has BYPASSRLS=true and silently bypasses RLS if anyone
  // ever points DATABASE_URL back at it.
  await warnIfLegacyRolePresent({
    migrationUrl: databaseMigrationUrl,
    legacyRoleName,
    environmentName,
  });

  const databaseUrl = buildPooledDatabaseUrl({
    migrationUrl: databaseMigrationUrl,
    roleName: serviceRoleName,
    rolePassword,
  });

  return {
    ...entry,
    databaseUrl,
    databaseMigrationUrl,
    serviceRoleName,
    serviceRolePassword: rolePassword,
  };
}

async function warnIfLegacyRolePresent(options: {
  migrationUrl: string;
  legacyRoleName: string;
  environmentName: string;
}): Promise<void> {
  const sql = postgres(options.migrationUrl, { max: 1, prepare: false, onnotice: logNeonNotice });
  try {
    const rows = await sql<{ rolname: string; rolbypassrls: boolean }[]>`
      SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = ${options.legacyRoleName}
    `;
    const legacy = rows[0];
    if (!legacy) return;
    logger.warn(
      `  Legacy runtime role "${options.legacyRoleName}" still present on "${options.environmentName}" (rolbypassrls=${legacy.rolbypassrls}). ` +
        'It was created via the Neon REST API by older setup:infra runs and silently bypasses RLS if any service points DATABASE_URL at it. ' +
        'Drop it manually after confirming nothing references it: `DROP ROLE IF EXISTS ' +
        options.legacyRoleName +
        ';` via DATABASE_MIGRATION_URL.',
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function provision(
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
  environments: string[],
): Promise<ProviderResult> {
  const apiKey = secrets.neon.apiKey;
  const neonConfig = config.providers.neon;
  const projectName = config.project.name;

  const spinner = logger.startSpinner('Creating Neon project...');

  try {
    const orgId = await ensureNeonOrgId(apiKey, secrets, config);
    let projectId = state.neon?.projectId;
    const branches: Record<string, NeonBranchEntry> = state.neon?.branches
      ? ({ ...state.neon.branches } as Record<string, NeonBranchEntry>)
      : {};

    // Adopt remote project by name when local state is missing the project ID.
    if (!projectId) {
      const existingProjectId = await findExistingProjectId(apiKey, projectName, orgId);
      if (existingProjectId) {
        projectId = existingProjectId;
        logger.stopSpinner(
          spinner,
          `Neon project adopted: "${projectName}" (Neon id: ${projectId})`,
        );
      }
    }

    if (!projectId) {
      // Neon requires `org_id` NESTED INSIDE the `project` object for personal API keys.
      // A top-level body field, the `?org_id=` query param, and the `Neon-Org-Id` header are all
      // ignored by POST /projects and yield "org_id is required" (org-scoped keys infer it). The
      // query param is kept for observability/back-compat only; the nested value is authoritative.
      const projectBody = {
        project: {
          name: projectName,
          org_id: orgId,
          region_id: neonConfig.region,
          pg_version: neonConfig.pgVersion,
          default_endpoint_settings: {
            autoscaling_limit_min_cu: neonConfig.computeSize.min,
            autoscaling_limit_max_cu: neonConfig.computeSize.max,
          },
        },
      };

      const createProjectUrl = `${NEON_API_BASE}/projects?org_id=${encodeURIComponent(orgId)}`;
      logger.info(
        `Neon create project request: POST ${createProjectUrl} (org_id nested inside project body)`,
      );

      const createResponse = await setupFetch({
        name: 'Neon',
        url: createProjectUrl,
        init: {
          method: 'POST',
          headers: neonHeaders(apiKey, orgId),
          body: JSON.stringify(projectBody),
        },
      });

      const responseText = await createResponse.text();
      logger.info(
        `Neon create project response: status=${createResponse.status} body=${responseText.slice(0, 500)}${responseText.length > 500 ? '...' : ''}`,
      );

      if (!createResponse.ok) {
        throw new Error(
          `Neon API POST /projects failed (${createResponse.status}): ${responseText}`,
        );
      }
      const projectResponse = JSON.parse(responseText) as NeonProject;

      projectId = projectResponse.project.id;
      logger.stopSpinner(spinner, `Neon project created: "${projectName}" (Neon id: ${projectId})`);
      // No per-environment pre-population here: the single branch-resolution pass below maps every
      // environment to its configured branch. The project's freshly created default branch is
      // adopted by whichever environment's configured branch name matches it (production → "main").
    } else {
      logger.stopSpinner(
        spinner,
        `Neon project already exists: "${projectName}" (Neon id: ${projectId})`,
      );
    }

    if (projectId === undefined) {
      throw new Error(
        'Neon projectId is unset after create/adopt flow (unreachable; both branches assign it).',
      );
    }
    const neonProjectId: string = projectId;

    await waitForOperations(apiKey, neonProjectId);

    const remoteBranches = await listBranches(apiKey, neonProjectId);

    // Resolve a branch for EVERY environment in one POSITION-INDEPENDENT pass.
    //
    // Each environment maps to a Neon branch named after the environment (development →
    // "development", production → "production"). The environment whose Neon branch name matches the
    // project's DEFAULT branch (Neon auto-creates one, typically "main") adopts that default branch;
    // every other environment gets its own branch created. Crucially this does NOT depend on an
    // environment's position in `environments`, so it is correct whether provision() runs with all
    // environments at once OR one at a time. Environment-first traversal calls it per-environment
    // (a single-element array); the old "last element = production = default branch" logic then
    // collapsed every environment onto the default branch, so the `dev` branch was never created
    // and development silently shared production's database.
    const defaultRemoteBranch =
      remoteBranches.find((branch) => branch.default) ??
      remoteBranches.find((branch) => branch.name === 'main') ??
      remoteBranches[0];

    for (const environmentName of environments) {
      const neonBranchName = getNeonBranchName(config, environmentName);
      const existingEntry = branches[environmentName];
      if (existingEntry?.branchId) {
        logger.success(`  Branch "${environmentName}" (Neon: ${neonBranchName}) already resolved`);
        continue;
      }

      // Adopt a remote branch with the configured name, or the project's default branch when the
      // configured name IS the default's (production → "main"). Otherwise create the named branch.
      const adopted =
        remoteBranches.find((branch) => branch.name === neonBranchName) ??
        (defaultRemoteBranch?.name === neonBranchName ? defaultRemoteBranch : undefined);

      if (adopted) {
        await waitForOperations(apiKey, neonProjectId);
        branches[environmentName] = {
          ...(existingEntry ?? {}),
          branchId: adopted.id,
          endpointId: existingEntry?.endpointId ?? '',
          databaseUrl: existingEntry?.databaseUrl ?? '',
        };
        logger.success(
          `  Branch "${neonBranchName}" adopted for "${environmentName}": ${adopted.id}`,
        );
        continue;
      }

      const branchSpinner = logger.startSpinner(
        `Creating Neon branch "${neonBranchName}" for environment "${environmentName}"...`,
      );

      await waitForOperations(apiKey, neonProjectId);

      const branchResponse = await neonRequest<NeonBranch>(
        apiKey,
        'POST',
        `/projects/${neonProjectId}/branches`,
        {
          branch: { name: neonBranchName },
          endpoints: [{ type: 'read_write' }],
        },
      );

      const branchId = branchResponse.branch.id;
      const endpointId = branchResponse.endpoints?.[0]?.id ?? '';

      branches[environmentName] = {
        ...(existingEntry ?? {}),
        branchId,
        endpointId,
        databaseUrl: existingEntry?.databaseUrl ?? '',
      };
      logger.stopSpinner(
        branchSpinner,
        `Branch "${neonBranchName}" created for "${environmentName}": ${branchId}`,
      );
    }

    // Ensure each environment has a runtime role + populated DATABASE_URL and
    // DATABASE_MIGRATION_URL, then grant least-privilege access on the existing
    // schemas. Idempotent for re-runs.
    for (const environmentName of environments) {
      const entry = branches[environmentName];
      if (!entry?.branchId) {
        throw new Error(
          `Neon branch for environment "${environmentName}" was not resolved; cannot create runtime role.`,
        );
      }
      const updated = await ensureBranchRuntimeRole({
        apiKey,
        projectId: neonProjectId,
        environmentName,
        entry,
      });
      branches[environmentName] = updated;
    }

    return {
      success: true,
      message: `Neon: ${Object.keys(branches).length} branches ready with runtime roles`,
      stateUpdates: { neon: { projectId: neonProjectId, branches } },
    };
  } catch (provisionError) {
    const message =
      provisionError instanceof Error ? provisionError.message : String(provisionError);
    logger.failActiveSpinner(`Neon provisioning failed: ${message}`);
    return { success: false, message };
  }
}

export async function check(state: SetupState, secrets: SetupSecrets): Promise<boolean> {
  if (!state.neon?.projectId) {
    logger.error('Neon: no project in state');
    return false;
  }

  try {
    await neonRequest(secrets.neon.apiKey, 'GET', `/projects/${state.neon.projectId}`);
    logger.success(`Neon project ${state.neon.projectId} — reachable`);
    return true;
  } catch {
    logger.error(`Neon project ${state.neon.projectId} — unreachable`);
    return false;
  }
}

function allEnvironmentsHaveBranch(environments: string[], state: SetupState): boolean {
  const branches = state.neon?.branches;
  if (!branches) return false;
  return environments.every((environmentName) => {
    const entry = branches[environmentName];
    const expectedRoleName = getServiceRoleName(environmentName);
    // Require the recorded role to match the SQL-managed convention AND carry a password we
    // can reuse. State written by the legacy REST-API role flow (`<env>_service_user` with
    // no `serviceRolePassword`) deliberately fails this check so the provider re-runs and
    // creates the new `<env>_app_login` role via SQL.
    return Boolean(
      entry?.branchId &&
        entry?.databaseUrl &&
        entry?.databaseMigrationUrl &&
        entry?.serviceRoleName === expectedRoleName &&
        entry?.serviceRolePassword,
    );
  });
}

function countEnvironmentsWithServiceRole(state: SetupState): number {
  const branches = state.neon?.branches;
  if (!branches) return 0;
  return Object.values(branches).filter((entry) => Boolean(entry?.serviceRoleName)).length;
}

export const setupNeonProvider: InfraProvider = {
  key: 'neon',
  name: 'Neon Postgres',
  isEnabled: ({ config, secrets }) =>
    config.providers.neon.enabled && isSecretFilled(secrets.neon.apiKey),
  disabledReason: ({ config }) =>
    !config.providers.neon.enabled
      ? 'disabled in setup.config.json'
      : 'NEON_API_KEY missing in .setup/.setup-credentials',
  preview: ({ config }) =>
    config.providers.neon.enabled
      ? {
          detail: '1 project + branches per env',
          url: 'https://console.neon.tech/app/settings/api-keys',
          configKey: 'neon.apiKey',
        }
      : null,
  settingsReview: ({ config, environments }) =>
    config.providers.neon.enabled
      ? [
          {
            bucket: 'resource',
            provider: 'Neon Postgres',
            detail: `1 project + ${environments.length} branches (${config.providers.neon.region})`,
          },
        ]
      : [],
  detectExisting: async ({ config, secrets }) => {
    if (!(config.providers.neon.enabled && isSecretFilled(secrets.neon.apiKey))) return [];
    try {
      const orgId = await ensureNeonOrgId(secrets.neon.apiKey, secrets, config);
      const { projects } = await neonRequest<NeonProjectsListResponse>(
        secrets.neon.apiKey,
        'GET',
        '/projects',
        undefined,
        { org_id: orgId },
        orgId,
      );
      const match = projects?.find((project) => project.name === config.project.name);
      if (match) {
        return [
          {
            provider: 'Neon Postgres',
            detail: `project "${config.project.name}" already exists (${match.id})`,
          },
        ];
      }
    } catch {
      logger.warn('  Could not check Neon for existing resources');
    }
    return [];
  },
  describe: ({ config, environments }) => ({ project: config.project.name, environments }),
  inspectRemote: async ({ config, secrets, environments }) => {
    if (!config.providers.neon.enabled) {
      return { present: false, fields: [], error: 'disabled in setup.config.json' };
    }
    const apiKey = secrets.neon.apiKey;
    if (!isSecretFilled(apiKey)) {
      return {
        present: false,
        fields: [],
        error: 'NEON_API_KEY missing in .setup/.setup-credentials',
      };
    }
    const expectedName = config.project.name;
    try {
      const orgId = await ensureNeonOrgId(apiKey, secrets, config);
      const { projects } = await neonRequest<{
        projects: Array<{ id: string; name: string; pg_version?: number; region_id?: string }>;
      }>(apiKey, 'GET', '/projects', undefined, { org_id: orgId }, orgId);
      const project = projects.find((entry) => entry.name === expectedName);
      if (!project) {
        return {
          present: false,
          fields: [{ label: 'project', expected: expectedName, remote: '—', matches: false }],
        };
      }
      const fields = [
        { label: 'project', expected: expectedName, remote: project.name, matches: true },
        {
          label: 'pg version',
          expected: String(config.providers.neon.pgVersion),
          remote: String(project.pg_version ?? '—'),
          matches: project.pg_version === config.providers.neon.pgVersion,
        },
        {
          label: 'region',
          expected: config.providers.neon.region,
          remote: project.region_id ?? '—',
          matches: project.region_id === config.providers.neon.region,
        },
      ];
      const { branches } = await neonRequest<{ branches: Array<{ name: string }> }>(
        apiKey,
        'GET',
        `/projects/${project.id}/branches`,
      );
      {
        const remoteBranches = new Set(branches.map((branch) => branch.name));
        for (const environmentName of environments) {
          const expectedBranch = environmentName;
          const present = remoteBranches.has(expectedBranch);
          fields.push({
            label: `branch (${environmentName})`,
            expected: expectedBranch,
            remote: present ? expectedBranch : '—',
            matches: present,
          });
        }
      }
      return { present: true, fields };
    } catch (error) {
      return {
        present: false,
        fields: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  toEnvironmentVariables: ({ config, secrets, state }, environmentName) => {
    // The scheduled restore drill drives the Neon API itself; it uses the same key setup does.
    const drillKey: Record<string, string> =
      config.providers.neon.enabled && secrets.neon?.apiKey
        ? { MONTHLY_DATABASE_RESTORE_DRILL_NEON_API_KEY: secrets.neon.apiKey }
        : {};
    const branch = state.neon?.branches?.[environmentName];
    if (!branch) return drillKey;
    const variables: Record<string, string> = { ...drillKey, DATABASE_URL: branch.databaseUrl };
    // DATABASE_MIGRATION_URL must be the DIRECT (non-pooler) owner URL captured at provision time
    // (getConnectionUri with pooled: false). NEVER fall back to branch.databaseUrl — that is the
    // POOLED, least-privilege runtime URL, and migrate.ts rejects a pooler host (the migration
    // advisory lock needs a session pinned to one Postgres backend). A pooler value here is worse
    // than an absent one, so when the direct URL is not recorded we omit the key and let the operator
    // re-run provisioning to capture it, rather than write a knowingly-broken migration URL.
    if (branch.databaseMigrationUrl) {
      variables.DATABASE_MIGRATION_URL = branch.databaseMigrationUrl;
    }
    return variables;
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'Neon Postgres',
    enabled: setupNeonProvider.isEnabled(context),
    enabledReason: setupNeonProvider.disabledReason(context),
    instructions: [
      `Will provision a Neon project named "${context.config.project.name}" in ${context.config.providers.neon.region}.`,
      `Will create or adopt branches for: ${context.environments.join(', ')}.`,
      'Idempotent: existing projects/branches are adopted, not recreated.',
    ],
    detectStatus: () =>
      resourceStatus(
        Boolean(context.state.neon?.projectId) &&
          allEnvironmentsHaveBranch(context.environments, context.state),
        'project + all environment branches (with runtime role + migration URL) in state',
      ),
    execute: async () => {
      const result = await provision(
        context.config,
        context.secrets,
        context.state,
        context.environments,
      );
      if (!result.success) throw new Error(result.message);
      context.applyStateUpdates(result.stateUpdates ?? {});
      return result;
    },
    verifyState: () => {
      const branchCount = Object.keys(context.state.neon?.branches ?? {}).length;
      const withRole = countEnvironmentsWithServiceRole(context.state);
      return {
        ok: Boolean(context.state.neon?.projectId) && Boolean(context.state.neon?.branches),
        message: context.state.neon?.projectId
          ? `project ${context.state.neon.projectId} with ${branchCount} branch(es), ${withRole} with runtime role`
          : 'no Neon project recorded',
      };
    },
    verifyLive: async () => {
      const ok = await check(context.state, context.secrets);
      return { ok, message: ok ? 'reachable' : 'unreachable' };
    },
  }),
  check: ({ state, secrets }) => check(state, secrets),
  deleteInstructions: ({ state }) => {
    if (!state.neon?.projectId) return [];
    const resources: Array<{ label: string; identifier: string }> = [
      { label: 'Project', identifier: state.neon.projectId },
    ];
    for (const [environmentName, branch] of Object.entries(state.neon.branches ?? {})) {
      resources.push({
        label: `Branch (${environmentName})`,
        identifier: `${branch.branchId}`,
      });
    }
    return [
      {
        provider: 'Neon Postgres',
        dashboardUrl: `https://console.neon.tech/app/projects/${state.neon.projectId}`,
        steps: [
          'Open the project page above.',
          'Settings → Delete project (deletes all branches in one go), or open Branches and delete individually.',
        ],
        resources,
      },
    ];
  },
};
