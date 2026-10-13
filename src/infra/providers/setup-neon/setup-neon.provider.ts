/**
 * Neon Postgres provider for `pnpm setup:infra`.
 *
 * Provisions one Neon project per environment — its own storage, history and computes, so no
 * environment's data can be branched into another — and the backend's database users in each;
 * records the connection URLs to state.
 *
 * NAMING (single source of truth = setup.config.json): every Neon name derives from
 * `config.project.name` and `config.environments[].name` (see {@link neonEnvironmentNames}) — never
 * hardcoded, never Neon's defaults (`main`, `neondb`, `neondb_owner`).
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

/** The Neon resources of one environment — see {@link neonEnvironmentNames}. */
export interface NeonEnvironmentNames {
  /** Neon project, e.g. `clinozy-be-production`. */
  projectName: string;
  /** The project's only (default) branch — the environment name, e.g. `production`. */
  branchName: string;
  /** The project's database, e.g. `clinozy_be_production`. */
  databaseName: string;
  /** The database's owner — setup's admin login, never an env value. */
  ownerRoleName: string;
}

/**
 * Every Neon name for one environment, derived from the project and environment names so all
 * environments follow one pattern (`clinozy-be` + `production` →):
 *   project  `clinozy-be-production`        Neon allows hyphens
 *   branch   `production`                   the environment name, independent of the git `deployBranch`
 *   database `clinozy_be_production`        underscores: a plain (unquoted) Postgres identifier,
 *                                           like the backend's own `clinozy_be_*` roles
 *   owner    `clinozy_be_production_owner`  Neon's own `{database}_owner` rule
 * Throws for an environment missing from setup.config.json or a name that is not a plain identifier.
 */
export function neonEnvironmentNames(
  config: SetupConfig,
  environmentName: string,
): NeonEnvironmentNames {
  const environment = config.environments.find((entry) => entry.name === environmentName);
  if (!environment) {
    throw new Error(`Unknown environment "${environmentName}" in setup.config.json`);
  }
  const projectName = `${config.project.name}-${environmentName}`;
  const databaseName = projectName.replace(/-/g, '_');
  const ownerRoleName = `${databaseName}_owner`;
  for (const identifier of [databaseName, ownerRoleName]) {
    if (!POSTGRES_IDENTIFIER_PATTERN.test(identifier)) {
      throw new Error(
        `Neon name "${identifier}" (from project "${config.project.name}" and environment "${environmentName}") is not a plain Postgres identifier.`,
      );
    }
  }
  return { projectName, branchName: environmentName, databaseName, ownerRoleName };
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
  // Keeps `channel_binding=require&sslmode=require` and the `/<database>` path.
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

/** POST /projects response — the project with the default branch and compute it created. */
interface NeonCreatedProject {
  project: {
    id: string;
    name: string;
  };
  branch?: {
    id: string;
    name: string;
  };
  endpoints?: Array<{
    id: string;
  }>;
}

interface NeonProjectDetails {
  project: {
    id: string;
    name: string;
    history_retention_seconds?: number;
  };
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
  /** Protected branches cannot be deleted, archived or reset (Neon paid plans). */
  protected?: boolean;
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

/** One environment's Neon project as recorded in state (`state.neon.projects[environment]`). */
interface NeonEnvironmentEntry {
  projectId: string;
  projectName: string;
  branchId: string;
  endpointId: string;
  databaseName: string;
  ownerRoleName: string;
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
  databaseName: string;
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
      database_name: options.databaseName,
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
 * `operator` (local/CI fixtures); `owner` is the NOLOGIN group that owns the tables. The Neon
 * project's database owner (`<database>_owner`, see {@link neonEnvironmentNames}) is only setup's
 * admin connection for managing these users — never written to an env file. The migrator gets BYPASSRLS like the provider owner it replaces: SECURITY DEFINER
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
  databaseName: string;
  roleName: string;
  savedPassword: string | undefined;
  environmentName: string;
  migrationLogin?: boolean;
}): Promise<{ outcome: LoginRoleOutcome; password: string }> {
  const {
    ownerUrl,
    databaseName,
    roleName,
    savedPassword,
    environmentName,
    migrationLogin = false,
  } = options;
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

    await sql.unsafe(`GRANT CONNECT ON DATABASE ${databaseName} TO ${roleName}`);
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
  databaseName: string;
  migratorRole: string;
  administeredRoles: readonly string[];
}): Promise<void> {
  const { ownerUrl, databaseName, migratorRole } = options;
  const sql = postgres(ownerUrl, { max: 1, prepare: false, onnotice: logNeonNotice });
  try {
    // Grant only what is missing: re-granting can fail ("grant options cannot be granted back to your
    // own grantor") where the provider owner is itself a member of the migrator — the backend's
    // migrations create it with an inheriting self-grant.
    const [held] = await sql<{ database: boolean; schema: boolean }[]>`
      SELECT has_database_privilege(${migratorRole}, ${databaseName}, 'CREATE WITH GRANT OPTION')
         AND has_database_privilege(${migratorRole}, ${databaseName}, 'CONNECT WITH GRANT OPTION')
         AND has_database_privilege(${migratorRole}, ${databaseName}, 'TEMPORARY WITH GRANT OPTION')
             AS database,
             has_schema_privilege(${migratorRole}, 'public', 'CREATE WITH GRANT OPTION')
         AND has_schema_privilege(${migratorRole}, 'public', 'USAGE WITH GRANT OPTION') AS schema
    `;
    if (!held?.database) {
      await sql.unsafe(
        `GRANT ALL ON DATABASE ${databaseName} TO ${migratorRole} WITH GRANT OPTION`,
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
  environmentName: string;
  entry: NeonEnvironmentEntry;
}

/**
 * Ensure the environment's database users and build its three connection strings. Idempotent: an
 * existing user whose saved password still works is left as it is, so connection strings (Railway,
 * GitHub Environments, local .env) stay stable across runs.
 */
async function ensureBranchDatabaseUsers(
  options: EnsureBranchDatabaseUsersOptions,
): Promise<NeonEnvironmentEntry> {
  const { config, apiKey, environmentName, entry } = options;
  const { databaseName } = entry;
  const appRole = backendRoleName(config, 'app');
  const maintenanceRole = backendRoleName(config, 'maintenance');
  const migratorRole = backendRoleName(config, 'migrator');

  // The database owner, direct host: setup's admin connection for the SQL below — never an env value.
  const ownerUrl = await getConnectionUri({
    apiKey,
    projectId: entry.projectId,
    branchId: entry.branchId,
    databaseName,
    roleName: entry.ownerRoleName,
    pooled: false,
  });

  const runtime = await ensureLoginRole({
    ownerUrl,
    databaseName,
    roleName: appRole,
    savedPassword:
      (entry.serviceRoleName === appRole ? entry.serviceRolePassword : undefined) ??
      passwordFromEnvUrl(readEnvFileValue(environmentName, 'DATABASE_URL'), appRole),
    environmentName,
  });
  logLoginRole(runtime.outcome, appRole, 'DATABASE_URL', environmentName);

  const maintenance = await ensureLoginRole({
    ownerUrl,
    databaseName,
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
    databaseName,
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
    databaseName,
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

const SECONDS_PER_DAY = 86_400;

/** The environment's point-in-time restore window from `providers.neon.historyRetentionDays`. */
function historyRetentionSeconds(config: SetupConfig, environmentName: string): number | undefined {
  const days = config.providers.neon.historyRetentionDays?.[environmentName];
  return days === undefined ? undefined : days * SECONDS_PER_DAY;
}

interface EnsureNeonProjectOptions {
  config: SetupConfig;
  apiKey: string;
  orgId: string;
  environmentName: string;
  names: NeonEnvironmentNames;
  knownProjectId: string | undefined;
}

interface ResolvedNeonProject {
  projectId: string;
  branchId: string;
  /** Known only when this run created the project. */
  endpointId: string;
}

/**
 * Adopt the environment's Neon project by name, or create it with its branch, database and owner
 * named per {@link neonEnvironmentNames}. An adopted project must already carry those names — setup
 * never renames, recreates or deletes a database — and gets the configured history retention.
 */
async function ensureNeonProject(options: EnsureNeonProjectOptions): Promise<ResolvedNeonProject> {
  const { config, apiKey, orgId, environmentName, names, knownProjectId } = options;
  const neonConfig = config.providers.neon;
  const retentionSeconds = historyRetentionSeconds(config, environmentName);
  const projectId =
    knownProjectId ?? (await findExistingProjectId(apiKey, names.projectName, orgId));

  if (!projectId) {
    // Neon requires `org_id` NESTED INSIDE the `project` object for personal API keys: a top-level
    // body field, the `?org_id=` query param and the `Neon-Org-Id` header are all ignored by
    // POST /projects ("org_id is required"; organization keys infer it). The query param and header
    // are kept for observability; the nested value is authoritative.
    const created = await neonRequest<NeonCreatedProject>(
      apiKey,
      'POST',
      '/projects',
      {
        project: {
          name: names.projectName,
          org_id: orgId,
          region_id: neonConfig.region,
          pg_version: neonConfig.pgVersion,
          ...(retentionSeconds !== undefined
            ? { history_retention_seconds: retentionSeconds }
            : {}),
          default_endpoint_settings: {
            autoscaling_limit_min_cu: neonConfig.computeSize.min,
            autoscaling_limit_max_cu: neonConfig.computeSize.max,
          },
          // Name the default branch, its database and the owner after the project — never Neon's
          // `main` / `neondb` / `neondb_owner`.
          branch: {
            name: names.branchName,
            database_name: names.databaseName,
            role_name: names.ownerRoleName,
          },
        },
      },
      { org_id: orgId },
      orgId,
    );
    const branchId = created.branch?.id;
    if (!branchId) {
      throw new Error(`Neon created project "${names.projectName}" but did not return its branch.`);
    }
    logger.success(
      `  Neon project created: "${names.projectName}" (Neon id: ${created.project.id}) — branch "${names.branchName}", database "${names.databaseName}", owner "${names.ownerRoleName}"`,
    );
    return {
      projectId: created.project.id,
      branchId,
      endpointId: created.endpoints?.[0]?.id ?? '',
    };
  }

  await waitForOperations(apiKey, projectId);
  const notCreatedBySetup =
    'Setup only adopts projects it created — delete this project in the Neon console and re-run.';
  const branch = (await listBranches(apiKey, projectId)).find(
    (entry) => entry.name === names.branchName,
  );
  if (!branch) {
    throw new Error(
      `Neon project "${names.projectName}" (${projectId}) has no branch "${names.branchName}". ${notCreatedBySetup}`,
    );
  }
  const { databases } = await neonRequest<{
    databases?: Array<{ name: string; owner_name: string }>;
  }>(apiKey, 'GET', `/projects/${projectId}/branches/${branch.id}/databases`);
  const database = databases?.find((entry) => entry.name === names.databaseName);
  if (database?.owner_name !== names.ownerRoleName) {
    throw new Error(
      `Neon project "${names.projectName}" (${projectId}) has no database "${names.databaseName}" owned by "${names.ownerRoleName}". ${notCreatedBySetup}`,
    );
  }
  if (retentionSeconds !== undefined) {
    const { project } = await neonRequest<NeonProjectDetails>(
      apiKey,
      'GET',
      `/projects/${projectId}`,
    );
    if (project.history_retention_seconds !== retentionSeconds) {
      await neonRequest(apiKey, 'PATCH', `/projects/${projectId}`, {
        project: { history_retention_seconds: retentionSeconds },
      });
      logger.success(
        `  History retention on "${names.projectName}" set to ${retentionSeconds / SECONDS_PER_DAY} day(s)`,
      );
    }
  }
  logger.success(`  Neon project adopted: "${names.projectName}" (Neon id: ${projectId})`);
  return { projectId, branchId: branch.id, endpointId: '' };
}

/**
 * Mark the environment's branch protected (no delete, archive or reset) when the environment is
 * `protected` in setup.config.json. Neon offers protection on paid plans only, so a refusal is a
 * warning rather than a failed setup.
 */
async function protectBranchIfConfigured(options: {
  config: SetupConfig;
  apiKey: string;
  environmentName: string;
  names: NeonEnvironmentNames;
  project: ResolvedNeonProject;
}): Promise<void> {
  const { config, apiKey, environmentName, names, project } = options;
  const environment = config.environments.find((entry) => entry.name === environmentName);
  if (!environment?.protected) return;
  const branch = (await listBranches(apiKey, project.projectId)).find(
    (entry) => entry.id === project.branchId,
  );
  if (branch?.protected) return;
  try {
    await waitForOperations(apiKey, project.projectId);
    await neonRequest(
      apiKey,
      'PATCH',
      `/projects/${project.projectId}/branches/${project.branchId}`,
      {
        branch: { protected: true },
      },
    );
    logger.success(`  Branch "${names.branchName}" on "${names.projectName}" is protected`);
  } catch (protectError) {
    const message = protectError instanceof Error ? protectError.message : String(protectError);
    logger.warn(
      `  Could not protect branch "${names.branchName}" on "${names.projectName}" (Neon allows it on paid plans only): ${message}`,
    );
  }
}

export async function provision(
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
  environments: string[],
): Promise<ProviderResult> {
  const apiKey = secrets.neon.apiKey;
  const spinner = logger.startSpinner('Resolving the Neon organization...');

  try {
    const orgId = await ensureNeonOrgId(apiKey, secrets, config);
    logger.stopSpinner(spinner, `Neon organization: ${orgId}`);
    const projects: Record<string, NeonEnvironmentEntry> = {
      ...((state.neon?.projects ?? {}) as Record<string, NeonEnvironmentEntry>),
    };

    // One project per environment, each with its own branch, database, owner and users.
    for (const environmentName of environments) {
      const names = neonEnvironmentNames(config, environmentName);
      const known = projects[environmentName];
      const project = await ensureNeonProject({
        config,
        apiKey,
        orgId,
        environmentName,
        names,
        knownProjectId: known?.projectId,
      });
      await waitForOperations(apiKey, project.projectId);
      await protectBranchIfConfigured({ config, apiKey, environmentName, names, project });
      projects[environmentName] = await ensureBranchDatabaseUsers({
        config,
        apiKey,
        environmentName,
        entry: {
          ...(known ?? {}),
          projectId: project.projectId,
          projectName: names.projectName,
          branchId: project.branchId,
          endpointId: project.endpointId || (known?.endpointId ?? ''),
          databaseName: names.databaseName,
          ownerRoleName: names.ownerRoleName,
          databaseUrl: known?.databaseUrl ?? '',
        },
      });
    }

    return {
      success: true,
      message: `Neon: ${environments.length} project(s) ready with their database users`,
      stateUpdates: { neon: { projects } },
    };
  } catch (provisionError) {
    const message =
      provisionError instanceof Error ? provisionError.message : String(provisionError);
    logger.failActiveSpinner(`Neon provisioning failed: ${message}`);
    return { success: false, message };
  }
}

export async function check(state: SetupState, secrets: SetupSecrets): Promise<boolean> {
  const projects = Object.values(state.neon?.projects ?? {});
  if (projects.length === 0) {
    logger.error('Neon: no project in state');
    return false;
  }

  let reachable = true;
  for (const { projectId, projectName } of projects) {
    try {
      await neonRequest(secrets.neon.apiKey, 'GET', `/projects/${projectId}`);
      logger.success(`Neon project "${projectName}" (${projectId}) — reachable`);
    } catch {
      logger.error(`Neon project "${projectName}" (${projectId}) — unreachable`);
      reachable = false;
    }
  }
  return reachable;
}

function allEnvironmentsHaveProject(
  config: SetupConfig,
  environments: string[],
  state: SetupState,
): boolean {
  const projects = state.neon?.projects;
  if (!projects) return false;
  const appRole = backendRoleName(config, 'app');
  return environments.every((environmentName) => {
    const entry = projects[environmentName];
    // Require the current users (runtime = the backend's app role, plus maintenance) with a password
    // we can reuse; state from an earlier user model fails this so the provider re-runs.
    return Boolean(
      entry?.projectId &&
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
  return Object.values(state.neon?.projects ?? {}).filter((entry) =>
    Boolean(entry?.serviceRoleName),
  ).length;
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
          detail: '1 project per env',
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
            detail: `${environments.length} projects: ${environments
              .map((environmentName) => neonEnvironmentNames(config, environmentName).projectName)
              .join(', ')} (${config.providers.neon.region})`,
          },
        ]
      : [],
  detectExisting: async ({ config, secrets, environments }) => {
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
      return environments.flatMap((environmentName) => {
        const { projectName } = neonEnvironmentNames(config, environmentName);
        const match = projects?.find((project) => project.name === projectName);
        return match
          ? [
              {
                provider: 'Neon Postgres',
                detail: `project "${projectName}" already exists (${match.id})`,
              },
            ]
          : [];
      });
    } catch {
      logger.warn('  Could not check Neon for existing resources');
    }
    return [];
  },
  describe: ({ config, environments }) => ({
    project: config.project.name,
    environments: environments.map(
      (environmentName) => neonEnvironmentNames(config, environmentName).projectName,
    ),
  }),
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
    try {
      const orgId = await ensureNeonOrgId(apiKey, secrets, config);
      const { projects } = await neonRequest<{
        projects: Array<{ id: string; name: string; pg_version?: number; region_id?: string }>;
      }>(apiKey, 'GET', '/projects', undefined, { org_id: orgId }, orgId);
      const fields: Array<{ label: string; expected: string; remote: string; matches: boolean }> =
        [];
      let present = true;
      for (const environmentName of environments) {
        const names = neonEnvironmentNames(config, environmentName);
        const project = projects.find((entry) => entry.name === names.projectName);
        if (!project) {
          present = false;
          fields.push({
            label: `project (${environmentName})`,
            expected: names.projectName,
            remote: '—',
            matches: false,
          });
          continue;
        }
        fields.push(
          {
            label: `project (${environmentName})`,
            expected: names.projectName,
            remote: project.name,
            matches: true,
          },
          {
            label: `pg version (${environmentName})`,
            expected: String(config.providers.neon.pgVersion),
            remote: String(project.pg_version ?? '—'),
            matches: project.pg_version === config.providers.neon.pgVersion,
          },
          {
            label: `region (${environmentName})`,
            expected: config.providers.neon.region,
            remote: project.region_id ?? '—',
            matches: project.region_id === config.providers.neon.region,
          },
        );
        const { branches } = await neonRequest<{ branches: Array<{ name: string }> }>(
          apiKey,
          'GET',
          `/projects/${project.id}/branches`,
        );
        const branchPresent = branches.some((branch) => branch.name === names.branchName);
        fields.push({
          label: `branch (${environmentName})`,
          expected: names.branchName,
          remote: branchPresent ? names.branchName : '—',
          matches: branchPresent,
        });
      }
      return { present, fields };
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
    const project = state.neon?.projects?.[environmentName];
    if (!project) return drillKey;
    const variables: Record<string, string> = { ...drillKey, DATABASE_URL: project.databaseUrl };
    // DATABASE_MIGRATION_URL is the migrator's DIRECT (non-pooler) URL recorded at provision time.
    // NEVER fall back to project.databaseUrl — that is the POOLED runtime URL, and migrate.ts rejects
    // a pooler host (the migration advisory lock needs a session pinned to one Postgres backend). When
    // the direct URL is not recorded the key is omitted, so a re-run captures it, rather than writing
    // a knowingly-broken migration URL.
    if (project.databaseMigrationUrl) {
      variables.DATABASE_MIGRATION_URL = project.databaseMigrationUrl;
    }
    if (project.databaseMaintenanceUrl) {
      variables.DATABASE_MAINTENANCE_URL = project.databaseMaintenanceUrl;
    }
    return variables;
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'Neon Postgres',
    enabled: setupNeonProvider.isEnabled(context),
    enabledReason: setupNeonProvider.disabledReason(context),
    instructions: [
      `Will provision one Neon project per environment in ${context.config.providers.neon.region}: ${context.environments
        .map((environmentName) => neonEnvironmentNames(context.config, environmentName).projectName)
        .join(', ')}.`,
      'Each project gets one branch named after its environment, a database and owner named after the project, and the backend database users.',
      'Idempotent: existing projects are adopted, not recreated.',
    ],
    detectStatus: () =>
      resourceStatus(
        allEnvironmentsHaveProject(context.config, context.environments, context.state),
        'a project per environment (with database users + migration URL) in state',
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
      const projectCount = Object.keys(context.state.neon?.projects ?? {}).length;
      const withRole = countEnvironmentsWithServiceRole(context.state);
      return {
        ok: projectCount > 0,
        message:
          projectCount > 0
            ? `${projectCount} project(s), ${withRole} with database users`
            : 'no Neon project recorded',
      };
    },
    verifyLive: async () => {
      const ok = await check(context.state, context.secrets);
      return { ok, message: ok ? 'reachable' : 'unreachable' };
    },
  }),
  check: ({ state, secrets }) => check(state, secrets),
  deleteInstructions: ({ state }) =>
    Object.entries(state.neon?.projects ?? {}).map(([environmentName, project]) => ({
      provider: 'Neon Postgres',
      dashboardUrl: `https://console.neon.tech/app/projects/${project.projectId}`,
      steps: [
        `Open the "${project.projectName}" project page above (the ${environmentName} environment).`,
        'Settings → Delete project (deletes its branch, database and users in one go).',
      ],
      resources: [
        {
          label: `Project (${environmentName})`,
          identifier: `${project.projectName} (${project.projectId})`,
        },
        { label: `Branch (${environmentName})`, identifier: project.branchId },
      ],
    })),
};
