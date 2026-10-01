/**
 * Render the setup-guide HTML by injecting the generated {@link GuideData} into the
 * committed template (`template.html`). The template's UI is fixed; only the data —
 * services, environments, project — comes from the real catalog.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GuideData } from './data.js';

/** The exact token the template carries as its data placeholder. */
const DATA_MARKER = '/*__GUIDE_DATA__*/ null';

export function templatePath(): string {
  return resolve(import.meta.dirname, 'template.html');
}

/** Inject `data` into the template and return the full, self-contained HTML document. */
export function renderGuideHtml(
  data: GuideData,
  template = readFileSync(templatePath(), 'utf-8'),
): string {
  if (!template.includes(DATA_MARKER)) {
    throw new Error('setup-guide template is missing its data marker');
  }
  return template.replace(DATA_MARKER, JSON.stringify(data));
}
