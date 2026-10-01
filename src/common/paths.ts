/**
 * Root resolution for the standalone `clinozy-infra` tool.
 *
 * `clinozy-infra` is a tool that provisions infrastructure FOR a target application repo (clinozy-be).
 * Two distinct roots exist and must never be conflated:
 *
 * - **tool root** — the `clinozy-infra` repo itself. Holds the tool's own inputs/state:
 *   `.setup/.setup-credentials`, `.setup-audit.log`, and `clinozy-infra`'s copy of `setup.config.json`.
 * - **target root** — the backend application repo being provisioned (default sibling `../clinozy-be`).
 *   Holds app artifacts the tool reads/writes: `.env.<environment>`, `.env.example`, `.github/**`.
 * - **frontend root** — the frontend application repo (default sibling `../clinozy-fe`), a fully
 *   independent target. The tool writes its `.env.<environment>` (browser-safe `VITE_*` keys) the
 *   same way it writes clinozy-be's. See {@link frontendRoot}.
 *
 * Target resolution order: `CLINOZY_BE_DIR` env → an explicit override set via {@link setTargetRoot}
 * (e.g. from `setup.config.json` `target.path`) → default sibling `../clinozy-be`, then validated to
 * exist so a mis-pointed target fails loudly instead of silently writing to the wrong place.
 * Frontend resolution mirrors this: `CLINOZY_FE_DIR` → `frontend.path` → `../clinozy-fe`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SetupError } from './setup-error.js';

let targetOverride: string | undefined;
let cachedTarget: string | undefined;

let frontendOverride: string | undefined;
let cachedFrontend: string | undefined;

/** The `clinozy-infra` repo root (this file lives at `src/common/paths.ts`). */
export function toolRoot(): string {
  return resolve(import.meta.dirname, '../..');
}

/**
 * Explicit target-repo override (e.g. from `setup.config.json` `target.path`), applied when set and
 * `CLINOZY_BE_DIR` is absent. Call before any `targetRoot()` use; clears the resolution cache.
 */
export function setTargetRoot(path: string | undefined): void {
  targetOverride = path && path.trim().length > 0 ? path.trim() : undefined;
  cachedTarget = undefined;
}

/** The target application repo root (clinozy-be). Validated to exist. */
export function targetRoot(): string {
  if (cachedTarget) return cachedTarget;
  const fromEnv = process.env.CLINOZY_BE_DIR?.trim();
  const candidate =
    fromEnv && fromEnv.length > 0
      ? resolve(fromEnv)
      : targetOverride
        ? resolve(toolRoot(), targetOverride)
        : resolve(toolRoot(), '..', 'clinozy-be');
  if (!existsSync(candidate)) {
    throw new SetupError(`Target repo not found at "${candidate}".`, {
      hint: 'Set CLINOZY_BE_DIR=/path/to/clinozy-be, or place clinozy-be as a sibling of clinozy-infra, or set target.path in setup.config.json.',
    });
  }
  cachedTarget = candidate;
  return cachedTarget;
}

/**
 * Explicit frontend-repo override (e.g. from `setup.config.json` `frontend.path`), applied when set
 * and `CLINOZY_FE_DIR` is absent. Call before any `frontendRoot()` use; clears the resolution cache.
 */
export function setFrontendRoot(path: string | undefined): void {
  frontendOverride = path && path.trim().length > 0 ? path.trim() : undefined;
  cachedFrontend = undefined;
}

/**
 * Resolve the frontend repo root (clinozy-fe) without validating existence.
 * Resolution order: `CLINOZY_FE_DIR` env → {@link setFrontendRoot} override (from
 * `setup.config.json` `frontend.path`) → default sibling `../clinozy-fe`.
 */
function resolveFrontendCandidate(): string {
  const fromEnv = process.env.CLINOZY_FE_DIR?.trim();
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
  if (frontendOverride) return resolve(toolRoot(), frontendOverride);
  return resolve(toolRoot(), '..', 'clinozy-fe');
}

/**
 * The frontend application repo root (clinozy-fe) — a fully independent target, resolved the same way
 * as {@link targetRoot} (clinozy-be). Validated to exist; throws when missing.
 */
export function frontendRoot(): string {
  if (cachedFrontend) return cachedFrontend;
  const candidate = resolveFrontendCandidate();
  if (!existsSync(candidate)) {
    throw new SetupError(`Frontend repo not found at "${candidate}".`, {
      hint: 'Set CLINOZY_FE_DIR=/path/to/clinozy-fe, or place clinozy-fe as a sibling of clinozy-infra, or set frontend.path in setup.config.json.',
    });
  }
  cachedFrontend = candidate;
  return cachedFrontend;
}

/**
 * Like {@link frontendRoot} but returns `undefined` instead of throwing when clinozy-fe is absent.
 * The env-export step uses this to warn-and-skip a missing/unchecked-out frontend rather than
 * failing the whole provisioning run.
 */
export function frontendRootIfExists(): string | undefined {
  if (cachedFrontend) return cachedFrontend;
  const candidate = resolveFrontendCandidate();
  if (!existsSync(candidate)) return undefined;
  cachedFrontend = candidate;
  return cachedFrontend;
}

/** Resolve a path inside the tool root (clinozy-infra). */
export function toolPath(...segments: string[]): string {
  return resolve(toolRoot(), ...segments);
}

/** Resolve a path inside the target repo (clinozy-be). */
export function targetPath(...segments: string[]): string {
  return resolve(targetRoot(), ...segments);
}

/** Resolve a path inside the frontend repo (clinozy-fe). Throws when clinozy-fe is absent. */
export function frontendPath(...segments: string[]): string {
  return resolve(frontendRoot(), ...segments);
}
