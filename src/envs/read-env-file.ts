/**
 * Reads a single value from a per-environment `.env.<environment>` file at the project root.
 *
 * Used to check what an app's env file already holds (e.g. Stripe / Google values, which setup
 * writes there from `.setup/.setup-credentials`). Returns `undefined` when the file is absent or
 * the key is empty.
 */
import { existsSync, readFileSync } from 'node:fs';
import { targetRoot } from '@setup/common/paths.js';
import { writeSecretFile } from '@setup/common/secure-file.js';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

function envFilePath(environmentName: string): string {
  return resolve(targetRoot(), `.env.${environmentName}`);
}

/**
 * Read one key's value from `.env.<environmentName>`.
 *
 * @remarks
 * **Side effects:** reads the env file from disk (no mutation). **Failure modes:** returns
 * `undefined` if the file does not exist or the key is missing/empty; never throws.
 */
export function readEnvFileValue(environmentName: string, key: string): string | undefined {
  const filePath = envFilePath(environmentName);
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = dotenv.parse(readFileSync(filePath, 'utf-8'));
    const value = parsed[key];
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read every `KEY=value` pair from `.env.<environmentName>` as a record.
 *
 * @remarks
 * Used by `setup:infra:output` to overlay the on-disk env file on top of the computed
 * `buildEnvironmentVariables()` view, so values written directly to the file (user-entered keys
 * like `STRIPE_*`, or provider upserts like `CAPTCHA_*`) are visible/`--copy`-able even though
 * they never flow through a provider's `toEnvironmentVariables` hook. **Side effects:** reads the
 * env file (no mutation). **Failure modes:** returns `{}` if the file is absent or unreadable.
 */
export function readEnvFile(environmentName: string): Record<string, string> {
  const filePath = envFilePath(environmentName);
  if (!existsSync(filePath)) return {};
  try {
    return dotenv.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write (replace in place, or append) a single `KEY=value` into `.env.<environmentName>`.
 *
 * @remarks
 * **Algorithm:** if a line `^KEY=` exists it is replaced, preserving every other line and
 * ordering; otherwise the pair is appended. The value is written verbatim (callers pass raw
 * secrets — never interpolated into a shell). **Side effects:** writes the env file to disk.
 * **Failure modes:** returns `false` if `.env.<environmentName>` does not exist (this helper
 * never creates the file); returns `true` on a successful write.
 */
export function setEnvFileValue(environmentName: string, key: string, value: string): boolean {
  const filePath = envFilePath(environmentName);
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf-8');
  const lineRegex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
  const next = lineRegex.test(content)
    ? content.replace(lineRegex, () => `${key}=${value}`) // literal: `$&` in a value stays as is
    : `${content.replace(/\n*$/, '')}\n${key}=${value}\n`;
  writeSecretFile(filePath, next);
  return true;
}

/**
 * Like {@link setEnvFileValue}, but CREATES `.env.<environmentName>` if it does not exist yet.
 *
 * @remarks
 * Used by the interactive credential collector (validate-only providers), which can run before
 * the export-env step has materialized the file. A freshly-created file holds just this line;
 * the later preserving export (`exportEnvFiles`) keeps it. **Side effects:** writes/creates the
 * env file. Always succeeds (no return value).
 */
export function upsertEnvFileValue(environmentName: string, key: string, value: string): void {
  const filePath = envFilePath(environmentName);
  if (!existsSync(filePath)) {
    writeSecretFile(filePath, `${key}=${value}\n`);
    return;
  }
  setEnvFileValue(environmentName, key, value);
}
