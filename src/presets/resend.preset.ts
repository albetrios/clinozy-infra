/**
 * Resend preset (validate-only).
 *
 * Validates the Resend API key (no resource is created — Resend exposes a single org-level key)
 * and contributes EMAIL_FROM_* (config-derived) + RESEND_API_KEY (once present) to the env files.
 */
import { resolveResendFromAddress, resolveResendFromName } from '@setup/common/resend-from.js';
import { isSecretFilled } from '@setup/common/secrets.js';
import { setupFetch } from '@setup/common/setup-fetch.js';
import type { EnvironmentVariables, ProviderResult } from '@setup/common/types.js';
import type { ValidatePreset } from './types.js';

async function validateResend(apiKey: string): Promise<ProviderResult> {
  if (!apiKey) return { success: true, message: 'Resend: skipped (no API key)' };
  await setupFetch({
    name: 'Resend',
    url: 'https://api.resend.com/api-keys',
    init: { headers: { Authorization: `Bearer ${apiKey}` } },
    expectedStatus: 200,
  });
  return { success: true, message: 'Resend: API key validated' };
}

export const resendPreset: ValidatePreset = {
  kind: 'validate',
  key: 'resend',
  name: 'Resend',
  isEnabled: ({ config, secrets }) =>
    config.providers.resend.enabled && isSecretFilled(secrets.resend.apiKey),
  disabledReason: ({ config }) =>
    !config.providers.resend.enabled
      ? 'disabled in setup.config.json'
      : 'RESEND_API_KEY missing in .setup/.setup-credentials',
  preview: { detail: 'API key', url: 'https://resend.com/api-keys', configKey: 'resend.apiKey' },
  settingsDetail: 'validate 1 key',
  credentials: ['RESEND_API_KEY'],
  dashboard: { url: 'https://resend.com/api-keys', label: 'Resend → API keys' },
  instructions: [
    'Will validate RESEND_API_KEY by calling https://api.resend.com/api-keys.',
    'No resource is created — Resend exposes a single org-level key.',
  ],
  outputs: [
    { key: 'RESEND_API_KEY', description: 'Resend org API key' },
    { key: 'EMAIL_FROM_ADDRESS', description: 'From address (config-derived)' },
    { key: 'EMAIL_FROM_NAME', description: 'From name (config-derived)' },
  ],
  toEnvironmentVariables: ({ config, secrets }) => {
    if (!config.providers.resend.enabled) return {};
    // EMAIL_FROM_* are plain config (derived from project identity), so emit them
    // whenever Resend is enabled — independent of whether the API key is set yet.
    const vars: Partial<EnvironmentVariables> = {
      EMAIL_FROM_ADDRESS: resolveResendFromAddress(config),
      EMAIL_FROM_NAME: resolveResendFromName(config),
    };
    // The key is a secret — only emit it once it is present in .setup-credentials.
    if (secrets.resend.apiKey) vars.RESEND_API_KEY = secrets.resend.apiKey;
    return vars;
  },
  validate: ({ secrets }) => validateResend(secrets.resend.apiKey),
};
