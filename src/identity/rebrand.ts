/**
 * `pnpm rebrand` — rename the product this repo provisions, end to end.
 *
 * Driven entirely by the identity in `package.json` + `setup.config.json` (see ./identity.ts).
 * Dry-run by default: nothing is written without `--apply`.
 *
 *   pnpm rebrand "Acme Portal"                      preview every change
 *   pnpm rebrand "Acme Portal" --apply              write them
 *   pnpm rebrand "Acme Portal" --repo acme/acme-be --apply
 *   pnpm identity:sync                              re-derive derived fields, no rename
 *
 * Defaults mirror the sibling frontend's `pnpm rebrand`: slug = kebab(product), backend
 * `<slug>-be`, frontend `<slug>-fe`, this tool `<slug>-infra`, namespace = first slug word,
 * display name "<Product> Backend", GitHub `<organization>/<backend>`.
 *
 * What it deliberately does NOT touch — printed as a checklist instead:
 *   - gitignored local state (`.setup/` credentials + provisioned-resource state, `.setup-audit.log`);
 *   - anything needing credentials (GitHub, Neon, AWS, Sentry, PostHog, Railway resources);
 *   - git history.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { toolRoot } from '@setup/common/paths.js';
import {
  type Identity,
  derivedSurfaces,
  kebab,
  kebabToUpperSnake,
  loadIdentity,
  planRebrand,
} from './identity.js';

const ROOT = toolRoot();
const muted = chalk.ansi256(243);

/** Parse `--flag value` pairs and bare `--flag` switches. */
function parseArgs(argv: readonly string[]): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next;
      index += 1;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { positional, flags };
}

/** First differing lines of each side, for a compact dry-run preview. */
function previewChange(before: string, after: string, limit = 2): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lines: string[] = [];
  for (
    let index = 0;
    index < Math.max(a.length, b.length) && lines.length < limit * 2;
    index += 1
  ) {
    if (a[index] === b[index]) continue;
    lines.push(`      ${muted(`${index + 1}:`)} ${a[index]?.trim() ?? ''}`);
    lines.push(`      ${muted(`${index + 1}:`)} ${chalk.green(b[index]?.trim() ?? '')}`);
  }
  return lines;
}

function usage(current: Identity): void {
  console.error(`${chalk.bold('pnpm rebrand "<Product Name>" [options]')}

  --name <slug>           this tool's package/repo name (default: <slug>-infra)
  --backend <slug>        backend repo name             (default: <slug>-be)
  --frontend <slug>       frontend repo name            (default: <slug>-fe)
  --namespace <prefix>    shared-resource prefix        (default: first word of <slug>)
  --display-name "<text>" backend display name          (default: "<Product> Backend")
  --repo <owner/repo>     backend GitHub slug           (default: <organization>/<backend>)
  --apply                 write changes (default is a dry run)

Current identity: ${current.productName} — ${current.toolName} → ${current.backendName} + ${current.frontendName} (${current.repository})`);
}

/** `pnpm identity:sync` — re-derive the derived surfaces from the CURRENT identity. */
function sync(current: Identity, apply: boolean): void {
  let changed = 0;
  for (const surface of derivedSurfaces(current)) {
    const path = join(ROOT, surface.file);
    const before = readFileSync(path, 'utf8');
    const after = surface.apply(before);
    if (after === before) continue;
    changed += 1;
    console.log(`  ${chalk.green('✓')} ${surface.file}  ${muted(`(${surface.label})`)}`);
    if (apply) writeFileSync(path, after);
  }
  console.log(
    changed === 0
      ? `  ${muted('Everything already matches the identity — nothing to do.')}\n`
      : `\n  ${chalk.bold(changed)} file(s) ${apply ? 'written' : 'would change — re-run with --apply'}.\n`,
  );
}

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const apply = flags.apply === true;
  const current = loadIdentity(ROOT);
  const mode = apply
    ? chalk.green('applying')
    : `${chalk.yellow('dry run')} (pass --apply to write)`;

  if (flags.sync === true) {
    console.log(`\n${chalk.bold('Identity sync')} — ${mode}\n`);
    sync(current, apply);
    return;
  }

  const productName = positional[0]?.trim();
  if (!productName) {
    usage(current);
    process.exitCode = 1;
    return;
  }

  const flag = (name: string): string | undefined =>
    typeof flags[name] === 'string' ? (flags[name] as string) : undefined;
  const slug = kebab(productName);
  if (!slug) {
    console.error(`"${productName}" has no letters or digits to build a slug from.`);
    process.exitCode = 1;
    return;
  }
  const backendName = flag('backend') ?? `${slug}-be`;
  const next: Identity = {
    ...current,
    productName,
    namespace: flag('namespace') ?? slug.split('-')[0] ?? slug,
    toolName: flag('name') ?? `${slug}-infra`,
    backendName,
    frontendName: flag('frontend') ?? `${slug}-fe`,
    displayName: flag('display-name') ?? `${productName} Backend`,
    repository: flag('repo') ?? `${current.organization}/${backendName}`,
  };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(next.repository)) {
    console.error(`--repo must be "owner/repo" — got "${next.repository}".`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${chalk.bold('Rebrand')} — ${mode}\n`);
  const rows: Array<[string, string, string]> = [
    ['product', current.productName, next.productName],
    ['namespace', current.namespace, next.namespace],
    ['this tool', current.toolName, next.toolName],
    ['backend', current.backendName, next.backendName],
    ['display name', current.displayName, next.displayName],
    ['frontend', current.frontendName, next.frontendName],
    ['github', current.repository, next.repository],
  ];
  for (const [label, from, to] of rows) {
    console.log(`  ${label.padEnd(12)} ${from}  →  ${chalk.bold(to)}`);
  }
  console.log('');

  const plan = planRebrand(ROOT, current, next);
  if (plan.files.length === 0) {
    console.log(`  ${muted('Everything already matches the identity — nothing to do.')}\n`);
    return;
  }
  for (const file of plan.files) {
    console.log(`  ${chalk.green('✓')} ${file.file}  ${muted(`(${file.reasons.join(', ')})`)}`);
    if (!apply) for (const line of previewChange(file.before, file.after)) console.log(line);
    if (apply) writeFileSync(join(ROOT, file.file), file.after);
  }
  console.log(
    `\n  ${chalk.bold(plan.files.length)} file(s) ${apply ? 'written' : 'would change'}; ` +
      `${plan.occurrences} prose/code occurrence(s); previousNames → ${JSON.stringify(plan.retired)}`,
  );
  if (!apply) {
    console.log(`  Re-run with ${chalk.bold('--apply')} to write.\n`);
    return;
  }

  // Names change length (`acme-be` → `zenith-be`), so a renamed line can cross Biome's line
  // width and turn `pnpm lint` red. Re-format exactly the files written; Biome's own
  // `files.includes` keeps it off docs and setup.config.json.
  const formatted = spawnSync(
    'pnpm',
    [
      'exec',
      'biome',
      'format',
      '--write',
      '--no-errors-on-unmatched',
      '--files-ignore-unknown=true',
      ...plan.files.map((file) => file.file),
    ],
    { cwd: ROOT, stdio: 'ignore' },
  );
  console.log(
    formatted.status === 0
      ? `  ${chalk.green('✓')} re-formatted the touched sources ${muted('(biome format)')}`
      : `  ${chalk.yellow('!')} biome format failed — run ${chalk.bold('pnpm format')} before committing`,
  );

  const oldDirVar = `${kebabToUpperSnake(current.backendName)}_DIR`;
  const newDirVar = `${kebabToUpperSnake(next.backendName)}_DIR`;
  console.log(`
${chalk.bold('Verify')}
  pnpm health              ${muted('# lint, typecheck, tests, identity')}
  pnpm validate:identity   ${muted(`# also cross-checks ../${next.backendName} and ../${next.frontendName}`)}

${chalk.bold('Manual steps this script cannot do')} ${muted('(credentials, local state, history)')}

  1. ${chalk.bold('Sibling repos')} — rename ${next.backendName} and ${next.frontendName} with their own
     identity tooling; validate:identity fails until all three agree.
  2. ${chalk.bold('Env vars')} — ${oldDirVar} / ${kebabToUpperSnake(current.frontendName)}_DIR are now ${newDirVar} /
     ${kebabToUpperSnake(next.frontendName)}_DIR; update any shell profile or CI that sets them.
  3. ${chalk.bold('Provisioned resources')} — the next ${chalk.bold('pnpm setup:infra')} derives NEW names
     (S3 bucket + IAM user prefix, Sentry project, PostHog/Turnstile ${next.namespace}-<env>, images,
     the ${next.backendName.replace(/-/g, '_')}_app role). Run ${chalk.bold('pnpm setup:infra:plan')} first; the
     gitignored ${chalk.bold('.setup/')} state still describes resources created under the old name.
  4. ${chalk.bold('GitHub')} — create/rename the repo for ${next.toolName} and point origin at it.
`);
}

main();
