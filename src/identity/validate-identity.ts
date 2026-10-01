/**
 * `pnpm validate:identity` — three guards that keep the product identity whole.
 *
 *  1. DRIFT — every derived field (see `derivedSurfaces`) must equal what the identity implies.
 *     Each transform is idempotent, so "applying it changes nothing" IS the check.
 *
 *  2. SIBLINGS — the backend and frontend repos this tool provisions must carry the same
 *     identity in their own `tooling/setup/setup.config.json`. A sibling that is not checked out
 *     is reported and skipped, so this repo's CI runs without them.
 *
 *  3. RETIRED NAMES — no name in `project.previousNames` may reappear, in any spelling the
 *     rebrand sweep rewrites (kebab, camelCase, UPPER_SNAKE, lower_snake) — not through a
 *     merge, a copy-paste from an older sibling, or a half-finished sweep.
 *
 * Usage: pnpm validate:identity
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@setup/common/config.js';
import { frontendRootIfExists, targetRoot, toolRoot } from '@setup/common/paths.js';
import {
  SIBLING_CONFIG,
  checkSiblings,
  findDrift,
  findPreviousNames,
  loadIdentity,
  renameableFiles,
} from './identity.js';

const ROOT = toolRoot();

/** Sibling roots as the provisioning run resolves them (env var → config path → default). */
function resolveSiblings(): { backend: string | undefined; frontend: string | undefined } {
  try {
    loadConfig(); // applies target.path / frontend.path from setup.config.json
  } catch {
    // An invalid config is reported by the run that needs it; fall back to the defaults here.
  }
  let backend: string | undefined;
  try {
    backend = targetRoot();
  } catch {
    backend = undefined;
  }
  return { backend, frontend: frontendRootIfExists() };
}

function main(): void {
  const identity = loadIdentity(ROOT);
  const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');
  let failed = false;

  // ── 1. Derived-field drift ─────────────────────────────────────────────────────────────────
  const drifted = findDrift(identity, read);
  if (drifted.length > 0) {
    failed = true;
    console.error(`\nidentity: ${drifted.length} derived field(s) disagree with the identity:\n`);
    for (const { file, label } of drifted) console.error(`  ✖ ${file}  (${label})`);
    console.error('\n  Fix: pnpm identity:sync\n');
  }

  // ── 2. Sibling repos ───────────────────────────────────────────────────────────────────────
  const roots = resolveSiblings();
  const checks = checkSiblings(identity, roots);
  const skipped = (['backend', 'frontend'] as const).filter(
    (repo) => !checks.some((check) => check.repo === repo),
  );
  for (const check of checks) {
    if (check.mismatches.length === 0) continue;
    failed = true;
    console.error(`\nidentity: the ${check.repo} repo (${check.root}) disagrees:\n`);
    for (const { field, expected, actual } of check.mismatches) {
      console.error(`  ✖ ${field}: expected "${expected}", found ${JSON.stringify(actual)}`);
    }
    console.error(`
  This tool provisions that repo, so both must carry one identity. Rebrand whichever side is
  stale with its own \`pnpm rebrand\`, or point this tool at the right checkout.
`);
  }

  // ── 3. A retired name coming back ──────────────────────────────────────────────────────────
  const resurrected = findPreviousNames(identity, renameableFiles(ROOT), read);
  if (resurrected.length > 0) {
    failed = true;
    const total = resurrected.reduce((sum, hit) => sum + hit.count, 0);
    console.error(
      `\nidentity: ${total} occurrence(s) of a retired name in ${resurrected.length} file(s):\n`,
    );
    for (const { file, name, count } of resurrected.slice(0, 20)) {
      console.error(`  ✖ ${file} — ${count}x "${name}"`);
    }
    if (resurrected.length > 20) console.error(`  … and ${resurrected.length - 20} more file(s)`);
    console.error(`
  This repo was renamed away from that name. Replace it with the current identity
  (package.json → name, setup.config.json → project / product / frontend).
`);
  }

  if (failed) process.exit(1);

  const checked = checks.map((check) => `${check.repo} ${check.root}`).join(', ') || 'none';
  const skippedNote =
    skipped.length > 0
      ? `; ${skipped.join(' + ')} not checked out (no ${SIBLING_CONFIG}) — skipped`
      : '';
  console.log(
    `identity: OK — ${identity.toolName} → ${identity.backendName} + ${identity.frontendName}; ` +
      `derived fields in sync; siblings agree (${checked})${skippedNote}; ` +
      `${identity.previousNames.length} retired name(s) absent.`,
  );
}

main();
