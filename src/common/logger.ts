import chalk from 'chalk';
import ora, { type Ora } from 'ora';

let activeSpinner: Ora | null = null;

/**
 * Theme-safe "muted" color. `muted` / `chalk.dim` use ANSI *bright-black*, which light-mode
 * terminals remap to a near-white that is invisible on a white background. The 256-color grayscale
 * ramp (232–255) is fixed RGB and NOT theme-remapped, so `ansi256(243)` (~#767676) renders as a
 * real mid-gray — readable on both light and dark backgrounds. Use this everywhere instead of gray.
 */
const muted = chalk.ansi256(243);

/**
 * Max printed line width for streaming process logs. Longer messages wrap with a hanging indent so
 * a long id / URL / instruction stays inside the viewport instead of running off to the right.
 */
const MAX_LINE_WIDTH = 100;

/**
 * Print a symbol-prefixed message, wrapping the text to {@link MAX_LINE_WIDTH} with a hanging indent
 * aligned under the message (never under the symbol). `prefixWidth` is the VISIBLE width of the raw
 * prefix (e.g. `"  ℹ "` → 4); the colored prefix is passed separately so ANSI codes don't skew it.
 */
function printWrapped(
  coloredPrefix: string,
  prefixWidth: number,
  message: string,
  color: (text: string) => string = (text) => text,
): void {
  // Preserve any leading indentation the caller baked into the message (e.g. aligned
  // "    Label : value" identity rows) — wrapCell trims it, which would break column alignment
  // for the one long row that wraps. Continuation lines align under the content, not the symbol.
  const lead = /^\s*/.exec(message)?.[0] ?? '';
  const body = message.slice(lead.length);
  const contentIndent = prefixWidth + lead.length;
  const width = Math.max(24, MAX_LINE_WIDTH - contentIndent);
  const [first, ...rest] = wrapCell(body, width);
  console.log(coloredPrefix + color(lead + (first ?? '')));
  const indent = ' '.repeat(contentIndent);
  for (const line of rest) console.log(indent + color(line));
}

export function banner(projectName: string, environments: string[]): void {
  const line = '═'.repeat(58);
  console.log('');
  console.log(chalk.cyan(`╔${line}╗`));
  console.log(
    chalk.cyan('║') +
      chalk.bold.white(`  ${projectName} — One-Command Setup`).padEnd(58) +
      chalk.cyan('║'),
  );
  console.log(
    chalk.cyan('║') +
      muted(`  Environments: ${environments.join(', ')}`).padEnd(58) +
      chalk.cyan('║'),
  );
  console.log(chalk.cyan(`╚${line}╝`));
  console.log('');
}

export interface EnvironmentBranchEntry {
  name: string;
  label?: string;
  branch: string;
  services?: string[];
  isDefault?: boolean;
}

export function environmentBranchMapping(entries: EnvironmentBranchEntry[]): void {
  if (entries.length === 0) return;
  const line = '─'.repeat(60);
  const branchWidth = Math.max(8, ...entries.map((entry) => entry.branch.length));
  const environmentWidth = Math.max(
    11,
    ...entries.map((entry) => `${entry.name}${entry.label ? ` (${entry.label})` : ''}`.length),
  );

  console.log(chalk.bold.cyan('  Branch / Environment / Services'));
  console.log(muted(`  ${line}`));
  for (const entry of entries) {
    const defaultMark = entry.isDefault ? chalk.yellow(' (default)') : '';
    const environment = `${entry.name}${entry.label ? ` (${entry.label})` : ''}`;
    const services = entry.services?.length ? entry.services.join(', ') : 'n/a';
    console.log(
      chalk.white('    ') +
        chalk.bold.green(entry.branch.padEnd(branchWidth)) +
        muted('  →  ') +
        chalk.bold.white(environment.padEnd(environmentWidth)) +
        defaultMark +
        muted('  →  services: ') +
        chalk.cyan(services),
    );
  }
  console.log(muted(`  ${line}`));
  console.log('');
}

export function stepHeader(step: number, total: number, providerName: string): void {
  // Compact single-line step marker (replaces a 4-line box) so a 15-step × N-environment run stays
  // scannable rather than scrolling through ~150 lines of borders. A leading blank separates it
  // from the previous step's output; the ▸ + bold name give it a clear visual anchor.
  const counter = `${step}/${total}`.padStart(5);
  console.log('');
  console.log(
    `  ${chalk.cyan.bold('▸')} ${muted(counter)}  ${chalk.bold.whiteBright(providerName)}`,
  );
}

export function info(message: string): void {
  printWrapped(chalk.blue('  ℹ '), 4, message);
}

/**
 * Like {@link info} but WITHOUT wrapping — for pre-formatted, column-aligned content (plan tables,
 * rule lines) where wrapping would break alignment. Callers own the width.
 */
export function infoRaw(message: string): void {
  console.log(chalk.blue('  ℹ ') + message);
}

export function success(message: string): void {
  printWrapped(chalk.green('  ✓ '), 4, message);
}

export function warn(message: string): void {
  printWrapped(chalk.yellow('  ⚠ '), 4, message);
}

export function error(message: string): void {
  printWrapped(chalk.red('  ✗ '), 4, message);
}

export function instruction(lines: string[]): void {
  // Demoted, compact rendering — instructions are secondary context beside the ✓ results, so no
  // boxed heading and no leading blank; muted text keeps the eye on outcomes. Long notes wrap to
  // MAX_LINE_WIDTH with a hanging indent under the text. One trailing blank separates the notes
  // from the step's result lines.
  const width = Math.max(24, MAX_LINE_WIDTH - 6);
  for (const line of lines) {
    const [first, ...rest] = wrapCell(line, width);
    console.log(`    ${chalk.cyan('›')} ${muted(first ?? '')}`);
    for (const cont of rest) console.log(`      ${muted(cont)}`);
  }
  console.log('');
}

export function secretField(path: string): void {
  console.log(chalk.cyan(`       ${path}`) + chalk.yellow('    <──'));
}

export function blank(): void {
  console.log('');
}

export function divider(): void {
  console.log(muted(`  ${'─'.repeat(56)}`));
}

export function startSpinner(message: string): Ora {
  activeSpinner = ora({ text: message, indent: 2 }).start();
  return activeSpinner;
}

export function stopSpinner(
  spinner: Ora,
  message: string,
  status: 'succeed' | 'fail' | 'warn' = 'succeed',
): void {
  if (status === 'succeed') spinner.succeed(message);
  else if (status === 'fail') spinner.fail(message);
  else spinner.warn(message);
  if (activeSpinner === spinner) {
    activeSpinner = null;
  }
}

/** Fail and clear any in-flight ora spinner (e.g. after an unhandled provision error). */
export function failActiveSpinner(message: string): void {
  if (!activeSpinner) return;
  activeSpinner.fail(message);
  activeSpinner = null;
}

export function summary(
  title: string,
  items: Array<{ label: string; value: string | string[] }>,
): void {
  console.log('');
  console.log(chalk.bold.green(`  ${title}`));
  divider();
  // Value column starts after the 2-space margin + 30-wide label. An array value prints one entry
  // per line (e.g. each Railway service on its own row), aligned under that column.
  const valueIndent = ' '.repeat(2 + 30);
  for (const item of items) {
    const values = Array.isArray(item.value) ? item.value : [item.value];
    console.log(chalk.white(`  ${item.label.padEnd(30)}`) + chalk.cyan(values[0] ?? ''));
    for (const extra of values.slice(1)) console.log(valueIndent + chalk.cyan(extra));
  }
  divider();
  console.log('');
}

export function table(rows: Array<{ env: string; status: string; detail: string }>): void {
  console.log('');
  console.log(chalk.bold(`  ${'Environment'.padEnd(14)}${'Status'.padEnd(12)}Detail`));
  divider();
  for (const row of rows) {
    const statusColor = row.status === 'OK' ? chalk.green : chalk.red;
    console.log(
      '  ' +
        chalk.white(row.env.padEnd(14)) +
        statusColor(row.status.padEnd(12)) +
        muted(row.detail),
    );
  }
  console.log('');
}

/** Color for a step status token. */
function statusColorFor(status: string): (text: string) => string {
  if (status === 'OK') return chalk.green;
  if (status === 'OFF' || status === 'SKIP') return chalk.yellow;
  return chalk.red;
}

/**
 * Reduce a noisy multi-line command failure to the single most meaningful line for summary
 * display. Strips shell echoes (`$ …`), dotenv notices (`◇ …`), pnpm lifecycle wrappers, blank
 * lines, and the generic "Command failed" preamble; prefers the line that names the real error so
 * a failure reads as one clean sentence instead of a 30-line dump.
 */
export function conciseFailureDetail(detail: string): string {
  const lines = detail
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('$ '))
    .filter((line) => !line.startsWith('◇'))
    .filter((line) => !/^\[ELIFECYCLE\]/i.test(line))
    .filter((line) => !/^command failed/i.test(line))
    .filter((line) => !/^publishing /i.test(line))
    .filter((line) => !/^successfully authenticated/i.test(line));
  const errorLine = lines.find((line) =>
    /error|not assigned|denied|forbidden|invalid|missing|failed|limit|unauthor|quota/i.test(line),
  );
  const chosen = errorLine ?? lines.at(-1) ?? detail.trim();
  return chosen.replace(/^\[[a-z]+\]\s*/i, '').trim();
}

/** Compact per-group status tally, e.g. "13 OK · 2 OFF · 1 FAIL" (only non-zero buckets). */
function statusTally(statuses: string[]): string {
  const order = ['OK', 'OFF', 'SKIP', 'FAIL', 'ABORT'];
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return order
    .filter((status) => counts.has(status))
    .map((status) => statusColorFor(status)(`${counts.get(status)} ${status}`))
    .join(muted(' · '));
}

/**
 * Grouped, width-aligned outcome summary. Step names of the form `"<provider> · <environment>"` are
 * grouped under each environment (in first-seen order); env-agnostic steps go under "General".
 * Columns are aligned to the longest provider name so status/detail never collide with the name.
 */
export function outcomeSummaryTable(
  rows: Array<{ env: string; status: string; detail: string }>,
): void {
  const SEPARATOR = ' · ';
  const parsed = rows.map((row) => {
    const index = row.env.lastIndexOf(SEPARATOR);
    return index === -1
      ? { provider: row.env, group: 'General', status: row.status, detail: row.detail }
      : {
          provider: row.env.slice(0, index),
          group: row.env.slice(index + SEPARATOR.length),
          status: row.status,
          detail: row.detail,
        };
  });

  const groups: string[] = [];
  for (const entry of parsed) if (!groups.includes(entry.group)) groups.push(entry.group);

  const providerWidth = Math.max(8, ...parsed.map((entry) => entry.provider.length));
  const statusWidth = Math.max(6, ...parsed.map((entry) => entry.status.length));
  const ruleWidth = providerWidth + statusWidth + 12;
  const detailWidth = 52;
  const detailIndent = ' '.repeat(2 + providerWidth + 2 + statusWidth + 2);

  for (const group of groups) {
    const groupRows = parsed.filter((row) => row.group === group);
    console.log('');
    console.log(
      chalk.bold.cyan(`  ${group}`) +
        muted('  —  ') +
        statusTally(groupRows.map((row) => row.status)),
    );
    console.log(muted(`  ${'─'.repeat(ruleWidth)}`));
    console.log(
      chalk.bold(`  ${'Provider'.padEnd(providerWidth)}  ${'Status'.padEnd(statusWidth)}  Detail`),
    );
    for (const entry of groupRows) {
      // Condense noisy multi-line command failures to one meaningful line, then wrap to a max
      // width; continuation lines are indented under the Detail column so rows stay readable.
      const detailLines = wrapCell(conciseFailureDetail(entry.detail), detailWidth);
      console.log(
        `  ${chalk.white(entry.provider.padEnd(providerWidth))}  ` +
          `${statusColorFor(entry.status)(entry.status.padEnd(statusWidth))}  ` +
          muted(detailLines[0] ?? ''),
      );
      for (const line of detailLines.slice(1)) {
        console.log(muted(`${detailIndent}${line}`));
      }
    }
  }
  console.log('');
}

export interface ProvisionedDetailRow {
  provider: string;
  /** Outcome label for this provider/env: created · failed · skipped · aborted · — . */
  status: string;
  organization: string;
  project: string;
  services: string;
  /** Concrete resource(s) created/recorded in state for this provider (e.g. "branch br-…"). */
  created: string;
}

/** Color for a provisioned-detail status label. */
function detailStatusColor(status: string): (text: string) => string {
  if (status === 'created') return chalk.green;
  if (status === 'failed' || status === 'aborted') return chalk.red;
  if (status === 'skipped') return chalk.yellow;
  return muted;
}

/**
 * Per-column max widths for the provisioned-detail table (Provider · Status · Organization ·
 * Project · Services · Created). Long values (registry URLs, id lists) are wrapped onto
 * continuation lines within their column instead of stretching the whole table off-screen.
 */
const PROVISIONED_DETAIL_MAX_WIDTHS = [42, 9, 22, 22, 28, 40] as const;

/**
 * Wrap a cell to a max width for column display. Prefers breaking on a space / comma / slash
 * boundary (keeps URLs and comma lists readable); hard-splits an unbroken token (long ids/URLs)
 * only when no boundary fits. Returns one entry per physical line.
 */
function wrapCell(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const lines: string[] = [];
  let remaining = text.trim();
  while (remaining.length > width) {
    let breakAt = -1;
    for (const separator of [' ', ',', '/']) {
      const at = remaining.lastIndexOf(separator, width);
      if (at > breakAt) breakAt = at;
    }
    // No boundary within the width → hard-break the token; otherwise keep the separator on
    // the current line so the continuation reads cleanly.
    breakAt = breakAt <= 0 ? width : breakAt + 1;
    lines.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

/**
 * Per-environment "what was provisioned" table. One section per environment (plus a shared section
 * for account/repo-scoped providers); columns are aligned across ALL sections so they line up.
 * Sections are supplied by the caller (driven by config.environments), so adding an environment
 * automatically adds a section.
 */
export function provisionedDetailTable(
  sections: Array<{ title: string; rows: ProvisionedDetailRow[] }>,
): void {
  const nonEmpty = sections.filter((section) => section.rows.length > 0);
  if (nonEmpty.length === 0) return;

  const columns = ['Provider', 'Status', 'Organization', 'Project', 'Services', 'Created'] as const;
  const statusColumnIndex = 1;
  const cellsOf = (row: ProvisionedDetailRow): string[] => [
    row.provider,
    row.status,
    row.organization,
    row.project,
    row.services,
    row.created,
  ];
  const allRows = nonEmpty.flatMap((section) => section.rows);
  const widths = columns.map((header, index) =>
    Math.min(
      PROVISIONED_DETAIL_MAX_WIDTHS[index] ?? 40,
      Math.max(header.length, ...allRows.map((row) => cellsOf(row)[index]?.length ?? 0)),
    ),
  );
  const renderLine = (values: readonly string[]): string =>
    values.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ');
  const ruleWidth = widths.reduce((sum, width) => sum + width, 0) + 2 * (columns.length - 1);

  console.log('');
  console.log(chalk.bold.whiteBright('  Provisioned — details by environment'));
  for (const section of nonEmpty) {
    console.log('');
    console.log(chalk.bold.cyan(`  ${section.title}`));
    console.log(muted(`  ${'─'.repeat(ruleWidth)}`));
    console.log(chalk.bold(`  ${renderLine(columns)}`));
    for (const row of section.rows) {
      // Wrap each cell to its column width; a row becomes as many physical lines as its
      // widest-wrapped cell, with continuation lines padded so columns stay aligned.
      const wrapped = cellsOf(row).map((cell, index) => wrapCell(cell, widths[index] ?? 0));
      const lineCount = Math.max(1, ...wrapped.map((cellLines) => cellLines.length));
      for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
        const rendered = wrapped
          .map((cellLines, index) => {
            const padded = (cellLines[lineIndex] ?? '').padEnd(widths[index] ?? 0);
            // Color the status only on its first line (the label never wraps).
            return index === statusColumnIndex && lineIndex === 0
              ? detailStatusColor(row.status)(padded)
              : padded;
          })
          .join('  ');
        console.log(`  ${rendered}`);
      }
    }
  }
  console.log('');
}

export function settingsReview(
  projectName: string,
  organization: string,
  environments: Array<string | EnvironmentBranchEntry>,
  resources: Array<{ provider: string; detail: string }>,
  extras: Array<{ provider: string; detail: string }>,
): void {
  const line = '─'.repeat(60);
  const entries = environments.map((environment) =>
    typeof environment === 'string' ? { name: environment, branch: '' } : environment,
  );
  const hasBranches = entries.some((entry) => entry.branch.length > 0);

  console.log('');
  console.log(chalk.bold.cyan('  SETTINGS REVIEW'));
  console.log(muted(`  ${line}`));
  console.log('');
  console.log(chalk.white('  Project:       ') + chalk.bold.white(projectName));
  console.log(chalk.white('  Organization:  ') + chalk.bold.white(organization));
  if (hasBranches) {
    const formatted = entries
      .map((entry) => {
        const environment = `${entry.name}${entry.label ? ` (${entry.label})` : ''}`;
        const services = entry.services?.length ? ` [services: ${entry.services.join(', ')}]` : '';
        return entry.branch ? `${entry.branch} → ${environment}${services}` : environment;
      })
      .join(', ');
    const branchesLabel = '  Branches:      ';
    printWrapped(chalk.white(branchesLabel), branchesLabel.length, formatted, chalk.bold.white);
  } else {
    console.log(
      chalk.white('  Environments:  ') +
        chalk.bold.white(entries.map((entry) => entry.name).join(', ')),
    );
  }
  // Width grows to fit the longest provider name (e.g. "Cloudflare Turnstile") so the detail never
  // glues onto the name; +2 keeps a readable gap.
  const providerWidth =
    Math.max(
      16,
      ...resources.map((resource) => resource.provider.length),
      ...extras.map((extra) => extra.provider.length),
    ) + 2;
  // Detail wraps under the provider column (hanging indent = "    + " marker + provider width) so a
  // long detail (e.g. the GitHub environments summary) stays inside the viewport.
  const detailIndent = 6 + providerWidth;
  console.log('');
  console.log(chalk.bold.yellow('  Resources to CREATE:'));
  for (const resource of resources) {
    printWrapped(
      chalk.green('    + ') + chalk.white(resource.provider.padEnd(providerWidth)),
      detailIndent,
      resource.detail,
      muted,
    );
  }
  if (extras.length > 0) {
    console.log('');
    console.log(chalk.bold.blue('  Additional actions:'));
    for (const extra of extras) {
      printWrapped(
        chalk.blue('    ~ ') + chalk.white(extra.provider.padEnd(providerWidth)),
        detailIndent,
        extra.detail,
        muted,
      );
    }
  }
  console.log('');
  console.log(muted(`  ${line}`));
  console.log('');
}

/**
 * Print the existing-resources notice shown before provisioning. These are **adopted/reused**, not
 * recreated (every provider is idempotent), so this is informational — not an error or an abort.
 */
export function existingResourcesNotice(
  existing: Array<{ provider: string; detail: string }>,
): void {
  const line = '─'.repeat(60);
  console.log('');
  console.log(
    chalk.bold.cyan('  EXISTING RESOURCES — will be adopted (idempotent, not recreated)'),
  );
  console.log(muted(`  ${line}`));
  console.log('');
  const providerWidth = Math.max(16, ...existing.map((resource) => resource.provider.length)) + 2;
  for (const resource of existing) {
    console.log(
      chalk.cyan('    • ') +
        chalk.white(resource.provider.padEnd(providerWidth)) +
        muted(resource.detail),
    );
  }
  console.log('');
  console.log(
    muted(
      '  These are reused, not recreated — safe to proceed. setup:infra never deletes; run "pnpm setup:infra --delete" for manual cleanup URLs if you want a clean slate.',
    ),
  );
  console.log(muted(`  ${line}`));
  console.log('');
}

export function previewPlan(
  configPath: string,
  secretsPath: string,
  providers: Array<{
    provider: string;
    detail: string;
    url: string;
    configKey: string;
  }>,
): void {
  const line = '─'.repeat(60);
  console.log('');
  console.log(chalk.bold.cyan('  SETUP PREVIEW — Third parties & token instructions'));
  console.log(muted(`  ${line}`));
  console.log('');
  console.log(chalk.white('  Config file:   ') + chalk.cyan(configPath));
  console.log(chalk.white('  Secrets file:  ') + chalk.cyan(secretsPath));
  console.log('');
  console.log(chalk.bold.yellow('  Providers to provision (fill tokens in secrets file):'));
  console.log('');
  for (const provider of providers) {
    console.log(chalk.green(`    ${provider.provider}`));
    console.log(muted(`      → ${provider.detail}`));
    console.log(muted(`      → Get token: ${provider.url}`));
    console.log(muted(`      → In .setup/.setup-credentials: ${provider.configKey}=<value>`));
    console.log('');
  }
  console.log(muted(`  ${line}`));
  console.log(
    chalk.bold.white(
      '  Token-only: No gh auth login or railway login required when GITHUB_TOKEN and RAILWAY_TOKEN are set in .setup/.setup-credentials.',
    ),
  );
  console.log(
    muted('  See docs/deployment/setup-token-instructions.md for GITHUB_TOKEN step-by-step.'),
  );
  console.log('');
  console.log(chalk.bold.white(`  Next step: Fill ${secretsPath}`));
  console.log(muted('  Then run: pnpm setup:infra (double confirm before provisioning)'));
  console.log('');
}

export interface DeleteInstructionsBlock {
  provider: string;
  dashboardUrl: string;
  steps?: string[];
  resources: Array<{ label: string; identifier: string }>;
}

/**
 * Renders the manual-delete guide for `pnpm setup:infra --delete`.
 * setup:infra does not delete anything — this only prints dashboard URLs and
 * the identifiers from the run state so the user can clean up by hand.
 */
export function deleteInstructionsReview(blocks: DeleteInstructionsBlock[]): void {
  const line = '─'.repeat(60);
  console.log('');
  console.log(chalk.bold.red('  MANUAL-DELETE GUIDE'));
  console.log(muted(`  ${line}`));
  console.log(
    chalk.yellow(
      '  setup:infra never deletes resources. Open each dashboard below and remove the listed items by hand.',
    ),
  );
  console.log('');

  if (blocks.length === 0) {
    console.log(muted('  No provisioned resources recorded in .setup-state.json.'));
    console.log('');
    console.log(muted(`  ${line}`));
    console.log('');
    return;
  }

  for (const block of blocks) {
    console.log(chalk.bold.white(`    ${block.provider}`));
    console.log(muted('      Dashboard: ') + chalk.cyan(block.dashboardUrl));
    if (block.resources.length === 0) {
      console.log(muted('      Resources: none recorded'));
    } else {
      console.log(muted('      Resources to delete:'));
      const labelWidth = Math.max(...block.resources.map((resource) => resource.label.length), 12);
      for (const resource of block.resources) {
        console.log(
          chalk.red('        - ') +
            chalk.white(resource.label.padEnd(labelWidth)) +
            muted('  ') +
            chalk.cyan(resource.identifier),
        );
      }
    }
    if (block.steps && block.steps.length > 0) {
      console.log(muted('      Steps:'));
      for (const step of block.steps) {
        console.log(muted(`        • ${step}`));
      }
    }
    console.log('');
  }

  console.log(muted(`  ${line}`));
  console.log(
    chalk.yellow(
      '  After deleting in the dashboards, also remove the entries from tooling/setup/.setup-state.json (or delete the file) so a fresh re-run does not adopt them.',
    ),
  );
  console.log('');
}
