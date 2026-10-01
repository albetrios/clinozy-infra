/**
 * `setup:infra:status` matrix — an OFFLINE service × environment table (set / partial /
 * vaulted / missing), read straight from `.env.<environment>` (+ KeyStash when enabled).
 * The terminal twin of the generated guide cockpit; both share the guide's status logic,
 * so they can't disagree. No network — instant.
 */
import { loadConfig } from '@setup/common/config.js';
import * as logger from '@setup/common/logger.js';
import { readEnvFileValue } from '@setup/envs/read-env-file.js';
import { KeyStash, slotNote } from '@setup/integrations/keystash.js';
import { PRESETS } from '@setup/presets/index.js';
import { type GuideData, type GuideGroup, buildGuideData, withStatus } from './setup-guide/data.js';
import { keystashEnabled } from './providers/index.js';

export type CellState = 'set' | 'partial' | 'vaulted' | 'missing';

export interface StatusRow {
  name: string;
  group: GuideGroup;
  cells: Record<string, CellState>;
}

export interface StatusMatrix {
  environments: string[];
  rows: StatusRow[];
}

/** Build the matrix from guide data that already carries per-env status ({@link withStatus}). */
export function buildStatusMatrix(
  data: GuideData,
  options: { vaulted?: Set<string>; project?: string } = {},
): StatusMatrix {
  const project = options.project ?? data.project;
  const rows: StatusRow[] = data.services.map((service) => {
    const cells: Record<string, CellState> = {};
    for (const env of data.environments) {
      const status = service.status?.[env] ?? 'missing';
      let cell: CellState = status === 'complete' ? 'set' : status;
      const allVaulted =
        options.vaulted &&
        service.outputs.length > 0 &&
        service.outputs.every((key) =>
          options.vaulted?.has(`${key}::${slotNote(project, `.env.${env}`)}`),
        );
      if (allVaulted) cell = 'vaulted';
      cells[env] = cell;
    }
    return { name: service.name, group: service.group, cells };
  });
  return { environments: data.environments, rows };
}

const GLYPH: Record<CellState, string> = {
  set: '● set',
  partial: '◐ partial',
  vaulted: '◆ vaulted',
  missing: '○ missing',
};

/** Print the matrix as an aligned table. */
export function renderStatusMatrix(matrix: StatusMatrix): void {
  const nameWidth = Math.max(7, ...matrix.rows.map((r) => r.name.length));
  const colWidth = Math.max(10, ...matrix.environments.map((e) => e.length));

  const header =
    'service'.padEnd(nameWidth) +
    '  ' +
    matrix.environments.map((e) => e.padEnd(colWidth)).join('  ');
  logger.infoRaw(header);
  logger.infoRaw('─'.repeat(header.length));
  for (const row of matrix.rows) {
    const cells = matrix.environments.map((e) => GLYPH[row.cells[e] ?? 'missing'].padEnd(colWidth));
    logger.infoRaw(row.name.padEnd(nameWidth) + '  ' + cells.join('  '));
  }
}

/** CLI: compute + print the offline matrix (used at the top of `runStatus`). `-e` scopes envs. */
export function runStatusMatrix(environments?: string[]): void {
  const config = loadConfig();
  const base = environments
    ? buildGuideData(config, PRESETS, { environments })
    : buildGuideData(config, PRESETS);
  const data = withStatus(base, {
    readEnvValue: (env, key) => {
      try {
        return readEnvFileValue(env, key);
      } catch {
        return undefined;
      }
    },
    hasCredential: (name) => (process.env[name] ?? '').trim().length > 0,
  });

  let vaulted: Set<string> | undefined;
  if (keystashEnabled()) {
    try {
      vaulted = new KeyStash({ skipKeychain: true }).vaultedSlots();
    } catch {
      vaulted = undefined; // never let a KeyStash read break status
    }
  }

  renderStatusMatrix(
    buildStatusMatrix(data, {
      project: config.project.name,
      ...(vaulted ? { vaulted } : {}),
    }),
  );
}
