/**
 * `setup:infra:doctor` — config validation + footgun flags before a run.
 *
 * Pure {@link runDoctorChecks} (config + presets → diagnostics) so it is unit-testable;
 * {@link runDoctor} loads config and prints. Also run first inside `plan`
 * ({@link printDoctorSummary}) so problems surface before any work.
 */
import { getEnvironmentNames, loadConfig } from '@setup/common/config.js';
import * as logger from '@setup/common/logger.js';
import type { SetupConfig } from '@setup/common/types.js';
import { frontendOriginForEnvironment } from '@setup/envs/env-file-setup.util.js';
import { PRESETS, type Preset, lintPresets } from '@setup/presets/index.js';

export interface Diagnostic {
  level: 'error' | 'warn';
  message: string;
}

/** Run all config/preset footgun checks. Pure — no IO. */
export function runDoctorChecks(config: SetupConfig, presets: readonly Preset[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // 1. The preset catalog must be lint-clean.
  for (const [key, errors] of Object.entries(lintPresets(presets))) {
    for (const err of errors) {
      diagnostics.push({ level: 'error', message: `preset ${key}: ${err}` });
    }
  }

  // 2. Two presets declaring the same output key → last-writer-wins in the env file.
  const owner = new Map<string, string>();
  for (const preset of presets) {
    for (const output of preset.outputs ?? []) {
      const prev = owner.get(output.key);
      if (prev !== undefined && prev !== preset.key) {
        diagnostics.push({
          level: 'warn',
          message: `output ${output.key} is declared by both ${prev} and ${preset.key} (last wins)`,
        });
      } else {
        owner.set(output.key, preset.key);
      }
    }
  }

  // 3. OAuth enabled but no frontend origin to derive redirect URIs from (they point at the
  //    SPA's /callback/<provider> page — see oauthCallbackUrl).
  const oauthEnabled =
    config.providers.oauth.google.enabled || config.providers.oauth.github.enabled;
  if (oauthEnabled) {
    for (const env of getEnvironmentNames(config)) {
      if (!frontendOriginForEnvironment(config, env)) {
        diagnostics.push({
          level: 'warn',
          message: `OAuth enabled but frontend.url.${env} (SPA origin) is empty — redirect URIs can't be derived`,
        });
      }
    }
  }

  // 4. Production environment with unset public URLs.
  for (const env of config.environments) {
    if (env.nodeEnvironment !== 'production') continue;
    // Derived from product.domain when not set explicitly (frontendOriginForEnvironment).
    if (config.frontend?.name && !frontendOriginForEnvironment(config, env.name)) {
      diagnostics.push({
        level: 'warn',
        message: `no frontend URL for production environment "${env.name}" — set product.domain (or frontend.url.${env.name})`,
      });
    }
  }

  return diagnostics;
}

/** Print diagnostics; returns the number of errors (0 = clean). */
export function printDoctorSummary(diagnostics: Diagnostic[]): number {
  if (diagnostics.length === 0) {
    logger.success('doctor: no problems found');
    return 0;
  }
  let errors = 0;
  for (const d of diagnostics) {
    if (d.level === 'error') {
      errors += 1;
      logger.error(d.message);
    } else {
      logger.warn(d.message);
    }
  }
  return errors;
}

/** CLI entry (`setup:infra:doctor`). Exits 1 when any error is found. */
export function runDoctor(): void {
  const config = loadConfig();
  const errors = printDoctorSummary(runDoctorChecks(config, PRESETS));
  if (errors > 0) process.exit(1);
}
