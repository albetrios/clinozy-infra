/**
 * Writes `.env.<environment>` files for both targets (clinozy-be and clinozy-fe) via a SURGICAL upsert:
 * only the keys setup provisions are written; every existing comment, blank line, key ordering, and
 * user-added key is preserved byte-for-byte.
 *
 * On a re-run the file itself is the base — provisioned keys are updated in place (or appended under
 * a single `# --- managed by clinozy-infra ---` block), nothing else is touched. On first run (no
 * `.env.<environment>` yet) the target repo's `.env.example` is used as the seed so the initial file
 * inherits the curated template structure; the provisioned values are then upserted into it.
 *
 * Empty provisioned values are excluded so a stateless `setup:infra:export-env` (state is ephemeral,
 * hydrated from remote) never blanks an existing secret.
 *
 * The frontend repo (clinozy-fe) is an independent target: its own `.env.<environment>` is written the
 * same way, gated on `frontend.name` being set and the clinozy-fe repo being present.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCommand } from '@setup/common/exec.js';
import { loadConfig, getEnvironmentNames } from '@setup/common/config.js';
import * as logger from '@setup/common/logger.js';
import { frontendRoot, frontendRootIfExists, targetRoot } from '@setup/common/paths.js';
import { loadSecrets } from '@setup/common/secrets.js';
import { writeSecretFile } from '@setup/common/secure-file.js';
import { loadState } from '@setup/common/state.js';
import type { SetupConfig, SetupSecrets, SetupState } from '@setup/common/types.js';
import { upsertEnvContent } from '@setup/engine/index.js';
import { buildEnvironmentVariables } from './build-env-vars.js';
import { escapeEnvValue } from './env-file-format.util.js';
import {
  FRONTEND_FALLBACK_HEADER,
  buildFrontendEnvContent,
  freshFrontendValues,
  frontendEnvFileName,
  frontendEnvFilePath,
} from './frontend-env-keys.js';

/**
 * Fresh, non-empty provisioned backend values for one environment. State is ephemeral and comes
 * back empty on a stateless export, so empty values are dropped — an empty value must never blank
 * an existing secret via the upsert.
 */
function freshBackendValues(
  environmentName: string,
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
): Record<string, string> {
  const provisioned = buildEnvironmentVariables(environmentName, config, secrets, state);
  const fresh: Record<string, string> = {};
  for (const [key, value] of Object.entries(provisioned)) {
    const raw = typeof value === 'string' ? value : String(value ?? '');
    if (raw !== '') fresh[key] = raw;
  }
  return fresh;
}

/** Base text for a first-run write of a file that doesn't exist yet: the repo's `.env.example`. */
function seedFromExample(repoRoot: string, fallback: string): string {
  const examplePath = resolve(repoRoot, '.env.example');
  return existsSync(examplePath) ? readFileSync(examplePath, 'utf-8') : fallback;
}

export interface ExportResult {
  written: string[];
  merged: string[];
  frontendWritten: string[];
  frontendMerged: string[];
}

function writeBackendEnvFile(
  environmentName: string,
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
): 'written' | 'merged' {
  const filePath = resolve(targetRoot(), `.env.${environmentName}`);
  const hadExisting = existsSync(filePath);
  const base = hadExisting ? readFileSync(filePath, 'utf-8') : seedFromExample(targetRoot(), '');
  const fresh = freshBackendValues(environmentName, config, secrets, state);
  const { text } = upsertEnvContent(base, fresh, escapeEnvValue);
  writeSecretFile(filePath, text);
  return hadExisting ? 'merged' : 'written';
}

function writeFrontendEnvFile(
  environmentName: string,
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
): 'written' | 'merged' {
  const filePath = frontendEnvFilePath(environmentName);
  const hadExisting = existsSync(filePath);
  const base = hadExisting
    ? readFileSync(filePath, 'utf-8')
    : seedFromExample(frontendRoot(), `${FRONTEND_FALLBACK_HEADER}\n`);
  const fresh = freshFrontendValues(environmentName, config, secrets, state);
  const content = buildFrontendEnvContent(base, fresh);
  writeSecretFile(filePath, content);
  return hadExisting ? 'merged' : 'written';
}

function exportFrontendEnvFiles(
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
  environments: string[],
): Pick<ExportResult, 'frontendWritten' | 'frontendMerged'> {
  const frontendWritten: string[] = [];
  const frontendMerged: string[] = [];

  if (!config.frontend?.name) {
    return { frontendWritten, frontendMerged };
  }

  // clinozy-fe is an independent target. If the repo isn't checked out next to clinozy-infra,
  // warn and skip rather than failing the whole provisioning run.
  if (!frontendRootIfExists()) {
    logger.info(
      'Frontend repo (clinozy-fe) not found — skipping frontend .env export. Set CLINOZY_FE_DIR or frontend.path, or place clinozy-fe as a sibling of clinozy-infra.',
    );
    return { frontendWritten, frontendMerged };
  }

  for (const environmentName of environments) {
    const outcome = writeFrontendEnvFile(environmentName, config, secrets, state);
    const fileName = frontendEnvFileName(environmentName);
    if (outcome === 'merged') frontendMerged.push(fileName);
    else frontendWritten.push(fileName);
  }
  const root = frontendRootIfExists();
  if (root) {
    warnIfEnvFilesNotGitignored(
      root,
      environments.map((name) => frontendEnvFileName(name)),
    );
  }

  return { frontendWritten, frontendMerged };
}

/**
 * Warn (once) if the freshly written secret env files are NOT gitignored in their target repo —
 * so a stray `git add -A` can't commit live secrets. Uses `git check-ignore` for a precise answer;
 * silent when the target isn't a git repo (status 128).
 */
function warnIfEnvFilesNotGitignored(root: string, envFileNames: string[]): void {
  const notIgnored = envFileNames.filter((fileName) => {
    const result = runCommand('git', {
      args: ['check-ignore', '-q', fileName],
      cwd: root,
      allowFailure: true,
      timeoutMs: 5_000,
    });
    // 0 = ignored (good), 1 = NOT ignored (warn), 128 = not a git repo (skip).
    return result.status === 1;
  });
  if (notIgnored.length > 0) {
    logger.warn(
      `Secret file(s) ${notIgnored.join(', ')} are NOT gitignored in ${root} — add ".env.*" (and "!.env.example") to its .gitignore before committing to avoid leaking secrets.`,
    );
  }
}

/**
 * Writes `.env.<environment>` for each environment via surgical upsert. New files are seeded from
 * `.env.example`; existing files are edited in place — provisioned keys are updated/appended and
 * every other line (comments, custom keys, ordering) is preserved.
 */
export function exportEnvFiles(): ExportResult {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const state = loadState();
  const environments = getEnvironmentNames(config);

  const written: string[] = [];
  const merged: string[] = [];

  for (const environmentName of environments) {
    const outcome = writeBackendEnvFile(environmentName, config, secrets, state);
    if (outcome === 'merged') merged.push(`.env.${environmentName}`);
    else written.push(`.env.${environmentName}`);
  }
  warnIfEnvFilesNotGitignored(
    targetRoot(),
    environments.map((name) => `.env.${name}`),
  );

  const { frontendWritten, frontendMerged } = exportFrontendEnvFiles(
    config,
    secrets,
    state,
    environments,
  );

  return { written, merged, frontendWritten, frontendMerged };
}

/**
 * Export ONLY the frontend (clinozy-fe) `.env.<environment>` files — clinozy-be is never touched.
 * Same surgical semantics as the full export: upsert the mapped `VITE_*` keys, preserve every
 * other clinozy-fe key. Gated on `frontend.name` + the clinozy-fe repo being present.
 */
export function exportFrontendOnly(): Pick<ExportResult, 'frontendWritten' | 'frontendMerged'> {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const state = loadState();
  const environments = getEnvironmentNames(config);
  return exportFrontendEnvFiles(config, secrets, state, environments);
}

/** Run from CLI (pnpm setup:infra:export-env:fe). Writes only clinozy-fe's env files. */
export function runExportFrontendEnv(): void {
  logger.info('Exporting clinozy-fe .env.<environment> files (frontend only)...');
  logger.blank();

  const { frontendWritten, frontendMerged } = exportFrontendOnly();

  if (frontendWritten.length > 0) {
    logger.success(`Created frontend env file(s): ${frontendWritten.join(', ')}`);
  }
  if (frontendMerged.length > 0) {
    logger.info(`Updated frontend env file(s): ${frontendMerged.join(', ')}`);
  }
  if (frontendWritten.length === 0 && frontendMerged.length === 0) {
    logger.info(
      'No frontend written — set frontend.name in setup.config.json and ensure clinozy-fe is present.',
    );
  }
}

/**
 * Run from CLI (pnpm setup:infra:export-env). Exits on missing config/state.
 */
export function runExportEnv(): void {
  logger.info('Exporting environment variables to .env.<environment> files...');
  logger.blank();

  const { written, merged, frontendWritten, frontendMerged } = exportEnvFiles();

  if (written.length > 0) {
    logger.success(`Created ${written.length} file(s): ${written.join(', ')}`);
  }
  if (merged.length > 0) {
    logger.info(`Updated ${merged.length} existing file(s) in place: ${merged.join(', ')}`);
  }
  if (frontendWritten.length > 0) {
    logger.success(`Created frontend env file(s): ${frontendWritten.join(', ')}`);
  }
  if (frontendMerged.length > 0) {
    logger.info(`Updated frontend env file(s): ${frontendMerged.join(', ')}`);
  }
  if (
    written.length === 0 &&
    merged.length === 0 &&
    frontendWritten.length === 0 &&
    frontendMerged.length === 0
  ) {
    logger.info('No environments configured. Check tooling/setup/setup.config.json.');
  }
}
