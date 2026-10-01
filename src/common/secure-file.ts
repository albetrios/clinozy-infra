/**
 * Write helpers for secret-bearing files (`.env.<env>`, `.setup/.setup-credentials`).
 *
 * These files hold database URLs, JWT private keys, S3 secrets, provider tokens, etc. They must
 * never be world-readable — on a shared/multi-user host that would leak every credential. We write
 * them owner-only (0600) and `chmod` afterward because `writeFileSync`'s `mode` is only applied when
 * the file is CREATED — it does NOT reset permissions when overwriting an existing file.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

/** Write a secret-bearing file with owner-only permissions (0600), resetting mode on overwrite. */
export function writeSecretFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: 'utf-8', mode: SECRET_FILE_MODE });
  chmodSync(filePath, SECRET_FILE_MODE);
}

/** Ensure the directory for a secret file exists with owner-only permissions (0700). */
export function ensureSecretDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: SECRET_DIR_MODE });
}
