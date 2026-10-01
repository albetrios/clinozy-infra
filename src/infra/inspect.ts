/**
 * `pnpm setup:infra:inspect` — read-only remote inspection.
 *
 * For each selected provider, queries the live provider API and reports: is the resource
 * present, and does its config match `setup.config.json` field-by-field (project name,
 * environment names, branch, region, organization, …). No mutations.
 *
 * This is the source of remote truth — `setup:infra:plan --remote` consumes the same
 * `inspectRemote()` results to compute CREATE / UP-TO-DATE / UPDATE actions, so the two
 * never disagree. Degrades gracefully: a provider with no token / unreachable shows its
 * error and the command still exits clean.
 */
import { getEnvironmentNames, loadConfig } from '@setup/common/config.js';
import * as logger from '@setup/common/logger.js';
import { loadSecrets } from '@setup/common/secrets.js';
import { loadState } from '@setup/common/state.js';
import type { InfraProvider, RemoteInspection } from '@setup/common/types.js';
import {
  buildProviderContext,
  selectProviders,
  type ProviderSelectionInput,
} from './orchestrator.js';

/** Run a provider's inspectRemote, normalizing "not implemented" / thrown errors. */
async function inspectProvider(
  provider: InfraProvider,
  context: Parameters<NonNullable<InfraProvider['inspectRemote']>>[0],
): Promise<RemoteInspection> {
  if (!provider.inspectRemote) {
    return { present: false, fields: [], error: 'remote inspection not implemented' };
  }
  try {
    return await provider.inspectRemote(context);
  } catch (error) {
    return {
      present: false,
      fields: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const FIELD_COLUMNS = ['FIELD', 'EXPECTED', 'REMOTE', 'MATCH'] as const;

function renderFields(inspection: RemoteInspection): void {
  if (inspection.fields.length === 0) return;
  const rows = inspection.fields.map((field) => [
    field.label,
    field.expected || '—',
    field.remote || '—',
    field.matches ? '✓' : field.prerequisite && !field.matches ? '✗ MISSING PREREQUISITE' : '✗',
  ]);
  const widths = FIELD_COLUMNS.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (values: readonly string[]) =>
    `      ${values.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ')}`;
  logger.info(line(FIELD_COLUMNS));
  for (const row of rows) logger.info(line(row));
}

/** `setup:infra:inspect` entrypoint. */
export async function runInspect(
  options: { providerSelection?: ProviderSelectionInput } = {},
): Promise<void> {
  const config = loadConfig();
  const environments = getEnvironmentNames(config);
  const context = buildProviderContext(config, loadSecrets(config), loadState(), environments);
  const providers = selectProviders(options.providerSelection);

  logger.info(
    `Inspect — ${config.project.displayName} (${config.project.name}) · ${environments.join(', ')}`,
  );
  logger.blank();

  let driftCount = 0;
  let missingPrereqCount = 0;
  for (const provider of providers) {
    const inspection = await inspectProvider(provider, context);
    if (inspection.error) {
      logger.warn(`  ${provider.name} — ${inspection.error}`);
      continue;
    }
    const drifted = inspection.fields.filter((field) => !field.matches);
    const prereqMissing = drifted.filter((field) => field.prerequisite);
    driftCount += drifted.length - prereqMissing.length;
    missingPrereqCount += prereqMissing.length;
    const summary = inspection.present
      ? drifted.length === 0
        ? 'present, in sync'
        : `present, ${drifted.length} field(s) drifted`
      : 'absent';
    logger.info(`  ${provider.name} — ${summary}`);
    renderFields(inspection);
    logger.blank();
  }

  logger.info(
    `Inspect: ${driftCount} field(s) drifted, ${missingPrereqCount} missing prerequisite(s). Read-only — nothing was changed.`,
  );
}
