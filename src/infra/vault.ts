/**
 * `setup:infra:vault` — back-fill secrets already present in `.env.<environment>` into
 * KeyStash. Config-gated: does nothing unless `keystash: true` in `infra.config.ts`, so
 * machines without KeyStash are unaffected.
 *
 * Reads each service's output keys from `.env.<environment>` and vaults the ones that
 * are set (presence → the real value goes to the Keychain, never printed). Idempotent
 * per (key, env) slot.
 */
import { loadConfig } from '@setup/common/config.js';
import * as logger from '@setup/common/logger.js';
import { targetRoot } from '@setup/common/paths.js';
import { readEnvFileValue } from '@setup/envs/read-env-file.js';
import { KeyStash, slotNote } from '@setup/integrations/keystash.js';
import { PRESETS } from '@setup/presets/index.js';
import { buildGuideData } from './setup-guide/data.js';
import { keystashEnabled } from './providers/index.js';

export function runVault(): void {
  if (!keystashEnabled()) {
    logger.info('KeyStash is disabled — set `keystash: true` in infra.config.ts to enable it.');
    return;
  }

  const config = loadConfig();
  const data = buildGuideData(config, PRESETS);
  const keystash = new KeyStash();
  const projectPath = targetRoot();

  let added = 0;
  let updated = 0;
  let missing = 0;

  for (const env of data.environments) {
    for (const service of data.services) {
      for (const key of service.outputs) {
        const value = readEnvFileValue(env, key);
        if (!value) {
          missing += 1;
          continue;
        }
        const action = keystash.vault({
          name: key,
          provider: service.name,
          note: slotNote(config.project.name, `.env.${env}`),
          value,
          projectName: config.project.name,
          projectPath,
          envVar: key,
        });
        if (action === 'added') added += 1;
        else updated += 1;
      }
    }
  }

  logger.success(
    `Vaulted ${added} new, updated ${updated}${missing ? `, ${missing} not set` : ''}.`,
  );
}
