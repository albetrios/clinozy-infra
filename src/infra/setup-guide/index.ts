/**
 * `setup:infra:guide` — generate the human-facing setup guide (a self-contained HTML
 * page) FROM the real catalog. The human opens it to see every key, where to get it,
 * and where it goes; the agent/CLI stays on the backend and never touches env secrets.
 *
 * Because the guide is generated from `infra.config.ts` + the presets, it can never
 * drift from what the tool actually provisions.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '@setup/common/config.js';
import * as logger from '@setup/common/logger.js';
import { toolPath } from '@setup/common/paths.js';
import { readEnvFileValue } from '@setup/envs/read-env-file.js';
import { PRESETS } from '@setup/presets/index.js';
import { buildGuideData, withStatus } from './data.js';
import { renderGuideHtml } from './render.js';

export { buildGuideData, withStatus } from './data.js';
export { renderGuideHtml } from './render.js';

/** Write the generated guide to disk. `--out` overrides the path; `environments` scopes (-e). */
export function runGuide(options: { out?: string; environments?: string[] } = {}): void {
  const config = loadConfig();
  // Live status snapshot: presence of each key in .env.<env> / .setup-credentials.
  // `loadEnvSetupIntoProcess()` (in setup.ts) has already loaded the credentials into env.
  const base = options.environments
    ? buildGuideData(config, PRESETS, { environments: options.environments })
    : buildGuideData(config, PRESETS);
  const data = withStatus(base, {
    readEnvValue: (env, key) => {
      try {
        return readEnvFileValue(env, key);
      } catch {
        return undefined; // target repo not present — treat every key as unset
      }
    },
    hasCredential: (name) => (process.env[name] ?? '').trim().length > 0,
  });
  const html = renderGuideHtml(data);
  const outPath = options.out ? resolve(process.cwd(), options.out) : toolPath('setup-guide.html');
  writeFileSync(outPath, html, 'utf-8');

  logger.success(`Setup guide generated → ${outPath}`);
  logger.info(
    `${data.services.length} services · ${data.environments.length} environments. Open it in a browser.`,
  );
}
