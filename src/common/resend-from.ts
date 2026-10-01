/**
 * Resend "from" identity resolution.
 *
 * The Resend provider emits EMAIL_FROM_ADDRESS / EMAIL_FROM_NAME into
 * `.env.<environment>`. Both default to values DERIVED from the project identity
 * so a rename (changing `project.name` / `project.displayName` in
 * setup.config.json) propagates automatically — there is no hardcoded domain.
 *
 * `config.providers.resend.fromAddress` / `.fromName` act as explicit overrides:
 * a non-empty value pins it (e.g. a Resend-verified domain); empty => derive.
 */
import type { SetupConfig } from './types.js';

/** Derived sender address from a project name: `noreply@<project-name>.com`. */
export const deriveResendFromAddress = (projectName: string): string =>
  `noreply@${projectName}.com`;

/** Derived sender name from a project display name. */
export const deriveResendFromName = (displayName: string): string => displayName;

/** Explicit override in config, else the derived address. */
export function resolveResendFromAddress(config: SetupConfig): string {
  return config.providers.resend.fromAddress.trim() || deriveResendFromAddress(config.project.name);
}

/** Explicit override in config, else the derived name. */
export function resolveResendFromName(config: SetupConfig): string {
  return (
    config.providers.resend.fromName.trim() || deriveResendFromName(config.project.displayName)
  );
}
