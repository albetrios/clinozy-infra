/**
 * Neon Postgres provider for `pnpm setup:infra`.
 *
 * Provisions the Neon project, a branch per environment and the backend's database users on each;
 * records the connection URLs to state.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only (via build-env-vars), never printed to the
 * console; setup secret files are gitignored and written owner-only. See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import * as logger from '@setup/common/logger.js';
import { isForce } from '@setup/common/prompts.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import { isSecretFilled } from '@setup/common/secrets.js';
import { readEnvFileValue } from '@setup/envs/read-env-file.js';
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
 * Roles earlier setup versions created that hosted environments must not keep. Setup never deletes
 * anything — it names them and prints the SQL to drop them once nothing connects as them.
 */
function legacyRoles(environmentName: string): { roleName: string; why: string }[] {
  return [
    {
      roleName: `${environmentName}_service_user`,
      why: 'created via the Neon REST API, which gives it BYPASSRLS',
    },
    {
      roleName: `${environmentName}_app_login`,
      why: "the old runtime login; the runtime user is now the backend's app role",
    },
  ];
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

interface RoleUrlOptions {
  /** The owner's direct URL — host, database and TLS parameters are kept. */
  migrationUrl: string;
  roleName: string;
  rolePassword: string;
}

/** A direct (non-pooler) connection URL for one of the backend's database users. */
function buildDirectDatabaseUrl({ migrationUrl, roleName, rolePassword }: RoleUrlOptions): string {
  const url = new URL(migrationUrl);
  url.username = roleName;
  url.password = rolePassword;
  // Keeps `channel_binding=require&sslmode=require` and the `/neondb` path.
  return url.toString();
}

/** The pooled connection URL for one of the backend's database users. */
function buildPooledDatabaseUrl(options: RoleUrlOptions): string {
  const url = new URL(buildDirectDatabaseUrl(options));
  url.hostname = derivePooledHostFromMigrationUrl(options.migrationUrl);
  return url.toString();
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
   * Password for the runtime database user (the backend's app role; see `ensureLoginRole`).
   * Persisted so `pnpm setup:infra` is idempotent across runs; the same value
   * is inlined into `databaseUrl` and pushed to Railway / GitHub Environments.
   */
  serviceRolePassword?: string;
  /** Pooled URL as `<project>_maintenance` (the RLS-subject maintenance pool). */
  databaseMaintenanceUrl?: string;
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

/**
 * The backend's database users — its own roles, named `<project_name>_<purpose>` (e.g.
 * `clinozy_be_app`), the posture of its local parity setup (docs/deployment/runbooks/
 * maintenance-database-role.md and resource-limits.md). A hosted environment connects with three:
 *   - `app`          runtime, RLS-subject                         → DATABASE_URL (pooled)
 *   - `maintenance`  RLS-subject maintenance pool                 → DATABASE_MAINTENANCE_URL (pooled)
 *   - `migrator`     CREATEROLE BYPASSRLS, member of `owner`      → DATABASE_MIGRATION_URL (direct)
 * Workers share them (tenant jobs on `app`, retention/cleanup on `maintenance`). Never hosted:
 * `operator` (local/CI fixtures); `owner` is the NOLOGIN group that owns the tables. Neon's own
 * `neondb_owner` is only setup's admin connection for managing these users — never written to an
 * env file. The migrator gets BYPASSRLS like the provider owner it replaces: SECURITY DEFINER
 * resolvers run as the role that created them, and FORCE RLS would otherwise make them return no rows.
 *
 * Migrations run in the backend's deploy (GitHub Actions: migrate → seed → deploy) as the migrator —
 * the first one included — never here. They create these roles NOLOGIN but tolerate a role that
 * already exists, so setup creates the logins before the first deploy and migrations attach grants.
 */
type BackendRolePurpose = 'app' | 'maintenance' | 'migrator' | 'owner' | 'operator';

export function backendRoleName(config: SetupConfig, purpose: BackendRolePurpose): string {
  return `${config.project.name.replace(/-/g, '_')}_${purpose}`;
}

/**
 * The password already in `.env.<environment>` for `key` when that URL logs in as `user` — reused
 * so re-runs keep every connection string stable instead of rotating it (state is ephemeral).
 */
export function passwordFromEnvUrl(value: string | undefined, user: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (decodeURIComponent(url.username) !== user) return undefined;
    const password = decodeURIComponent(url.password);
    return ROLE_PASSWORD_PATTERN.test(password) ? password : undefined;
  } catch {
    return undefined;
  }
}

/** Does `password` log in as `roleName`? `undefined` when the check itself failed (network). */
async function passwordLogsIn(
  ownerUrl: string,
  roleName: string,
  password: string,
): Promise<boolean | undefined> {
  const url = buildDirectDatabaseUrl({ migrationUrl: ownerUrl, roleName, rolePassword: password });
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    onnotice: logNeonNotice,
  });
  try {
    await sql`SELECT 1`;
    return true;
  } catch (error) {
    // 28P01 invalid_password; 28000 invalid_authorization_specification (e.g. role cannot log in).
    const code = (error as { code?: string }).code;
    return code === '28P01' || code === '28000' ? false : undefined;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

type LoginRoleOutcome = 'created' | 'kept' | 'login-enabled' | 'password-reset';

/**
 * Create a database user when it is missing; leave an existing one untouched when the password saved
 * in `.env.<environment>` still logs in. Otherwise enable its login / set a new password, so the URL
 * setup writes always works. Created via SQL as the provider owner — never Neon's REST API, which
 * gives every role BYPASSRLS — and checked afterwards: runtime users must stay subject to row-level
 * security; the migration login (`migrationLogin`) must hold CREATEROLE BYPASSRLS.
 */
async function ensureLoginRole(options: {
  ownerUrl: string;
  roleName: string;
  savedPassword: string | undefined;
  environmentName: string;
  migrationLogin?: boolean;
}): Promise<{ outcome: LoginRoleOutcome; password: string }> {
  const { ownerUrl, roleName, savedPassword, environmentName, migrationLogin = false } = options;
  const attributes = migrationLogin ? ' CREATEROLE BYPASSRLS' : '';
  if (!POSTGRES_IDENTIFIER_PATTERN.test(roleName)) {
    throw new Error(`Refusing to manage unsafe role identifier: ${roleName}`);
  }
  const sql = postgres(ownerUrl, { max: 1, prepare: false, onnotice: logNeonNotice });
  try {
    const [existing] = await sql<{ rolcanlogin: boolean }[]>`
      SELECT rolcanlogin FROM pg_roles WHERE rolname = ${roleName}
    `;
    let outcome: LoginRoleOutcome;
    let password: string;
    if (!existing) {
      password = generateRolePassword();
      await sql.unsafe(`CREATE ROLE ${roleName} LOGIN${attributes} PASSWORD '${password}'`);
      outcome = 'created';
    } else if (!existing.rolcanlogin) {
      // Created NOLOGIN by the backend's migrations: enable it (runbook: ALTER ROLE … LOGIN PASSWORD).
      password = savedPassword ?? generateRolePassword();
      assertRolePasswordSafeForSql(password);
      await sql.unsafe(`ALTER ROLE ${roleName} WITH LOGIN${attributes} PASSWORD '${password}'`);
      outcome = 'login-enabled';
    } else {
      const works = savedPassword ? await passwordLogsIn(ownerUrl, roleName, savedPassword) : false;
      if (savedPassword && works !== false) {
        if (works === undefined) {
          logger.warn(
            `  Could not test the saved password for "${roleName}" on "${environmentName}" — left unchanged.`,
          );
        }
        password = savedPassword;
        outcome = 'kept';
      } else {
        // A deployed app may be connected with a password only its own env holds: re-keying would
        // lock it out until every copy is updated, so that takes an explicit --force.
        const [activity] = await sql<{ connections: number }[]>`
          SELECT count(*)::int AS connections FROM pg_stat_activity WHERE usename = ${roleName}
        `;
        const connections = activity?.connections ?? 0;
        if (connections > 0 && !isForce()) {
          throw new Error(
            `Database user "${roleName}" on "${environmentName}" is in use (${connections} connection(s)) but .env.${environmentName} has no working password for it. ` +
              'Restore that file, or re-run with --force to set a new password (then push it everywhere with github:sync).',
          );
        }
        password = generateRolePassword();
        await sql.unsafe(`ALTER ROLE ${roleName} WITH PASSWORD '${password}'`);
        outcome = 'password-reset';
      }
    }

    await sql.unsafe(`GRANT CONNECT ON DATABASE ${NEON_DEFAULT_DATABASE} TO ${roleName}`);
    let [current] = await sql<
      { rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }[]
    >`SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = ${roleName}`;
    if (migrationLogin && current && !(current.rolbypassrls && current.rolcreaterole)) {
      await sql.unsafe(`ALTER ROLE ${roleName} WITH${attributes}`);
      [current] = await sql<
        { rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }[]
      >`SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = ${roleName}`;
    }
    if (!current || current.rolsuper) {
      throw new Error(
        `Database user "${roleName}" on "${environmentName}" is missing or a superuser.`,
      );
    }
    if (migrationLogin ? !(current.rolbypassrls && current.rolcreaterole) : current.rolbypassrls) {
      throw new Error(
        migrationLogin
          ? `Migration user "${roleName}" on "${environmentName}" lacks CREATEROLE BYPASSRLS (rolcreaterole=${current.rolcreaterole} rolbypassrls=${current.rolbypassrls}).`
          : `Database user "${roleName}" on "${environmentName}" has rolbypassrls=true — it must stay subject to row-level security. ` +
              'Create it via SQL as the owner (not the Neon REST API / console / CLI, which all assign BYPASSRLS).',
      );
    }
    return { outcome, password };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function logLoginRole(
  outcome: LoginRoleOutcome,
  roleName: string,
  envKey: string,
  environmentName: string,
): void {
  const messages: Record<LoginRoleOutcome, string> = {
    created: `Created database user "${roleName}" → ${envKey}`,
    kept: `Database user "${roleName}" already exists — left unchanged → ${envKey}`,
    'login-enabled': `Enabled login for existing role "${roleName}" → ${envKey}`,
    'password-reset': `Database user "${roleName}" had no working password in .env.${environmentName} — set a new one (update anything else that uses it) → ${envKey}`,
  };
  if (outcome === 'password-reset') logger.warn(`  ${messages[outcome]}`);
  else logger.success(`  ${messages[outcome]}`);
}

/**
 * What the migration login needs beyond its attributes to run every migration from an empty database
 * the way the provider owner would: full rights (with grant option) on the database and on `public`
 * (the migration ledger lives there), and ADMIN over the backend roles it did not create itself — its
 * migrations grant `app` / `maintenance` to other roles. ADMIN only: no inherited privileges.
 */
async function grantMigrationPrivileges(options: {
  ownerUrl: string;
  migratorRole: string;
  administeredRoles: readonly string[];
}): Promise<void> {
  const { ownerUrl, migratorRole } = options;
  const sql = postgres(ownerUrl, { max: 1, prepare: false, onnotice: logNeonNotice });
  try {
    // Grant only what is missing: re-granting can fail ("grant options cannot be granted back to your
    // own grantor") where the provider owner is itself a member of the migrator — the backend's
    // migrations create it with an inheriting self-grant.
    const [held] = await sql<{ database: boolean; schema: boolean }[]>`
      SELECT has_database_privilege(${migratorRole}, ${NEON_DEFAULT_DATABASE}, 'CREATE WITH GRANT OPTION')
         AND has_database_privilege(${migratorRole}, ${NEON_DEFAULT_DATABASE}, 'CONNECT WITH GRANT OPTION')
         AND has_database_privilege(${migratorRole}, ${NEON_DEFAULT_DATABASE}, 'TEMPORARY WITH GRANT OPTION')
             AS database,
             has_schema_privilege(${migratorRole}, 'public', 'CREATE WITH GRANT OPTION')
         AND has_schema_privilege(${migratorRole}, 'public', 'USAGE WITH GRANT OPTION') AS schema
    `;
    if (!held?.database) {
      await sql.unsafe(
        `GRANT ALL ON DATABASE ${NEON_DEFAULT_DATABASE} TO ${migratorRole} WITH GRANT OPTION`,
      );
    }
    if (!held?.schema) {
      await sql.unsafe(`GRANT ALL ON SCHEMA public TO ${migratorRole} WITH GRANT OPTION`);
    }
    for (const roleName of options.administeredRoles) {
      if (!POSTGRES_IDENTIFIER_PATTERN.test(roleName)) {
        throw new Error(`Refusing to manage unsafe role identifier: ${roleName}`);
      }
      const [row] = await sql<{ present: boolean; admin: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleName}) AS present,
               COALESCE((SELECT bool_or(m.admin_option) FROM pg_auth_members m
                          WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = ${roleName})
                            AND m.member = (SELECT oid FROM pg_roles WHERE rolname = ${migratorRole})),
                        false) AS admin
      `;
      if (!row?.present || row.admin) continue;
      await sql.unsafe(
        `GRANT ${roleName} TO ${migratorRole} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface EnsureBranchDatabaseUsersOptions {
  config: SetupConfig;
  apiKey: string;
  projectId: string;
  environmentName: string;
  entry: NeonBranchEntry;
}

/**
 * Ensure the environment's database users and build its three connection strings. Idempotent: an
 * existing user whose saved password still works is left as it is, so connection strings (Railway,
 * GitHub Environments, local .env) stay stable across runs.
 */
async function ensureBranchDatabaseUsers(
  options: EnsureBranchDatabaseUsersOptions,
): Promise<NeonBranchEntry> {
  const { config, apiKey, projectId, environmentName, entry } = options;
  const appRole = backendRoleName(config, 'app');
  const maintenanceRole = backendRoleName(config, 'maintenance');
  const migratorRole = backendRoleName(config, 'migrator');

  // Neon's owner, direct host: setup's admin connection for the SQL below — never an env value.
  const ownerUrl = await getConnectionUri({
    apiKey,
    projectId,
    branchId: entry.branchId,
    roleName: NEON_OWNER_ROLE,
    pooled: false,
  });

  const runtime = await ensureLoginRole({
    ownerUrl,
    roleName: appRole,
    savedPassword:
      (entry.serviceRoleName === appRole ? entry.serviceRolePassword : undefined) ??
      passwordFromEnvUrl(readEnvFileValue(environmentName, 'DATABASE_URL'), appRole),
    environmentName,
  });
  logLoginRole(runtime.outcome, appRole, 'DATABASE_URL', environmentName);

  const maintenance = await ensureLoginRole({
    ownerUrl,
    roleName: maintenanceRole,
    savedPassword: passwordFromEnvUrl(
      readEnvFileValue(environmentName, 'DATABASE_MAINTENANCE_URL'),
      maintenanceRole,
    ),
    environmentName,
  });
  logLoginRole(maintenance.outcome, maintenanceRole, 'DATABASE_MAINTENANCE_URL', environmentName);

  const migrator = await ensureLoginRole({
    ownerUrl,
    roleName: migratorRole,
    savedPassword: passwordFromEnvUrl(
      readEnvFileValue(environmentName, 'DATABASE_MIGRATION_URL'),
      migratorRole,
    ),
    environmentName,
    migrationLogin: true,
  });
  await grantMigrationPrivileges({
    ownerUrl,
    migratorRole,
    administeredRoles: [
      appRole,
      maintenanceRole,
      backendRoleName(config, 'owner'),
      backendRoleName(config, 'operator'),
    ],
  });
  logLoginRole(
    migrator.outcome,
    migratorRole,
    'DATABASE_MIGRATION_URL (direct host; the deploy runs migrations as it)',
    environmentName,
  );

  await warnAboutLegacyRoles(ownerUrl, environmentName);

  return {
    ...entry,
    databaseUrl: buildPooledDatabaseUrl({
      migrationUrl: ownerUrl,
      roleName: appRole,
      rolePassword: runtime.password,
    }),
    databaseMigrationUrl: buildDirectDatabaseUrl({
      migrationUrl: ownerUrl,
      roleName: migratorRole,
      rolePassword: migrator.password,
    }),
    databaseMaintenanceUrl: buildPooledDatabaseUrl({
      migrationUrl: ownerUrl,
      roleName: maintenanceRole,
      rolePassword: maintenance.password,
    }),
    serviceRoleName: appRole,
    serviceRolePassword: runtime.password,
  };
}

/** Name any role from {@link legacyRoles} still on the branch, with the SQL to drop it by hand. */
async function warnAboutLegacyRoles(ownerUrl: string, environmentName: string): Promise<void> {
  const sql = postgres(ownerUrl, { max: 1, prepare: false, onnotice: logNeonNotice });
  try {
    for (const { roleName, why } of legacyRoles(environmentName)) {
      if (!POSTGRES_IDENTIFIER_PATTERN.test(roleName)) continue;
      const [role] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${roleName}`;
      if (!role) continue;
      logger.warn(
        `  Old database user "${roleName}" still exists on "${environmentName}" (${why}). ` +
          `Once nothing connects as it, drop it as the owner: DROP OWNED BY ${roleName}; DROP ROLE ${roleName};`,
      );
    }
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

    // Ensure each environment's database users and its DATABASE_URL / DATABASE_MAINTENANCE_URL /
    // DATABASE_MIGRATION_URL. Idempotent for re-runs.
    for (const environmentName of environments) {
      const entry = branches[environmentName];
      if (!entry?.branchId) {
        throw new Error(
          `Neon branch for environment "${environmentName}" was not resolved; cannot create its database users.`,
        );
      }
      const updated = await ensureBranchDatabaseUsers({
        config,
        apiKey,
        projectId: neonProjectId,
        environmentName,
        entry,
      });
      branches[environmentName] = updated;
    }

    return {
      success: true,
      message: `Neon: ${Object.keys(branches).length} branches ready with their database users`,
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

function allEnvironmentsHaveBranch(
  config: SetupConfig,
  environments: string[],
  state: SetupState,
): boolean {
  const branches = state.neon?.branches;
  if (!branches) return false;
  const appRole = backendRoleName(config, 'app');
  return environments.every((environmentName) => {
    const entry = branches[environmentName];
    // Require the current users (runtime = the backend's app role, plus maintenance) with a password
    // we can reuse; state from an earlier user model fails this so the provider re-runs.
    return Boolean(
      entry?.branchId &&
        entry?.databaseUrl &&
        entry?.databaseMigrationUrl &&
        entry?.databaseMaintenanceUrl &&
        entry?.serviceRoleName === appRole &&
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
    // DATABASE_MIGRATION_URL is the migrator's DIRECT (non-pooler) URL recorded at provision time.
    // NEVER fall back to branch.databaseUrl — that is the POOLED runtime URL, and migrate.ts rejects a
    // pooler host (the migration advisory lock needs a session pinned to one Postgres backend). When
    // the direct URL is not recorded the key is omitted, so a re-run captures it, rather than writing
    // a knowingly-broken migration URL.
    if (branch.databaseMigrationUrl) {
      variables.DATABASE_MIGRATION_URL = branch.databaseMigrationUrl;
    }
    if (branch.databaseMaintenanceUrl) {
      variables.DATABASE_MAINTENANCE_URL = branch.databaseMaintenanceUrl;
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
          allEnvironmentsHaveBranch(context.config, context.environments, context.state),
        'project + all environment branches (with database users + migration URL) in state',
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
          ? `project ${context.state.neon.projectId} with ${branchCount} branch(es), ${withRole} with database users`
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
